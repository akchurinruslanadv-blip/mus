// extensions/fetcher/src/queue_watcher.ts: Event-Driven Queue Pre-buffering via Deno.watchFs
import * as path from "@std/path";
import { config } from "./config.ts";
import { getDb, getActiveSession } from "./db.ts";
import { fetchAudioStream } from "./fetcher.ts";
import { enforceLruCache } from "./lru.ts";

let _isWatching = false;
let _isBuffering = false;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _lastQueueHash = "";

export function startQueueWatcher(): void {
  if (_isWatching) return;
  _isWatching = true;

  console.log(`[queue-watcher] Started reactive queue watcher for: ${config.dbPath}`);

  (async () => {
    try {
      const dbDir = path.dirname(config.dbPath);
      const watcher = Deno.watchFs(dbDir);

      for await (const event of watcher) {
        if (!_isWatching) break;

        // Check if the modified file is musik.db or wal
        const affectsDb = event.paths.some(p => p.includes("musik.db"));
        if (!affectsDb) continue;

        // Debounce
        if (_debounceTimer !== null) {
          clearTimeout(_debounceTimer);
        }
        _debounceTimer = setTimeout(() => {
          handleQueueChange().catch(err => {
            console.error(`[queue-watcher] Error handling queue update:`, err);
          });
        }, config.watchDebounceMs);
      }
    } catch (e) {
      console.error(`[queue-watcher] Watcher encountered error:`, e);
      _isWatching = false;
    }
  })();
}

export function stopQueueWatcher(): void {
  _isWatching = false;
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
}

export async function handleQueueChange(): Promise<void> {
  if (_isBuffering) return;
  const db = getDb();
  const session = getActiveSession(db);
  if (!session || !session.queue.length || !session.currentId) return;

  // Hash check to prevent duplicate work
  const currentHash = `${session.id}:${session.currentId}:${session.queue.map(q => q.track_id).join(",")}`;
  if (currentHash === _lastQueueHash) return;
  _lastQueueHash = currentHash;

  console.log(`[queue-watcher] Queue update detected for session ${session.id} (Next ${session.queue.length} tracks)`);

  // Pre-buffer next 1 upcoming track in queue (zero-latency playback transition)
  const upcoming = session.queue.slice(0, 1);
  _isBuffering = true;
  try {
    for (const item of upcoming) {
      let exists = false;
      let filePath = item.path;

      if (filePath) {
        exists = await Deno.stat(filePath).then(() => true).catch(() => false);
      }

      if (!exists) {
        const query = `${item.artist} - ${item.title}`.trim();
        let preferredYtdlId: string | undefined;
        try {
          const tRow = db.prepare(`SELECT ytdl_id FROM tracks WHERE id = ?`).get(item.track_id) as { ytdl_id?: string } | undefined;
          if (tRow?.ytdl_id) preferredYtdlId = tRow.ytdl_id;
          else {
            const extRow = db.prepare(`
              SELECT ytdl_id FROM external_catalog 
              WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
                AND ytdl_id IS NOT NULL AND length(ytdl_id) >= 11
              LIMIT 1
            `).get(item.artist, item.title) as { ytdl_id?: string } | undefined;
            if (extRow?.ytdl_id) preferredYtdlId = extRow.ytdl_id;
          }
        } catch {}

        console.log(`[queue-watcher] Pre-buffering upcoming track: "${query}" (ID: ${item.track_id}, ytdl: ${preferredYtdlId || "searching"})...`);

        const result = await fetchAudioStream(query, { mode: "cache", preferredYtdlId });
        if (result.success && result.filePath) {
          console.log(`[queue-watcher] Pre-buffered successfully: ${result.filename} (${(result.durationMs! / 1000).toFixed(1)}s)`);
          try {
            const conflict = db.prepare(`SELECT id FROM tracks WHERE path = ? AND id != ?`).get(result.filePath, item.track_id);
            if (!conflict) {
              db.prepare(`UPDATE tracks SET path = ?, file_size = ?, ytdl_id = COALESCE(?, ytdl_id), is_active = 1, updated_at = ? WHERE id = ?`).run(
                result.filePath,
                result.sizeBytes || 0,
                result.ytdlId || null,
                new Date().toISOString(),
                item.track_id
              );
            } else {
              db.prepare(`UPDATE tracks SET file_size = ?, ytdl_id = COALESCE(?, ytdl_id), is_active = 1, updated_at = ? WHERE id = ?`).run(
                result.sizeBytes || 0,
                result.ytdlId || null,
                new Date().toISOString(),
                item.track_id
              );
            }
          } catch (e) {
            console.warn(`[queue-watcher] Could not update tracks path for ${item.track_id}:`, e);
          }
        } else {
          console.warn(`[queue-watcher] Could not pre-buffer "${query}": ${result.error}`);
        }
      }
    }

    // Enforce 3 GB LRU limit in dynamic/
    await enforceLruCache(config.dynamicDir, config.cacheMaxGb);
  } finally {
    _isBuffering = false;
  }
}
