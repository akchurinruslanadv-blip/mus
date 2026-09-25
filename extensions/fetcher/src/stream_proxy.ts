// extensions/fetcher/src/stream_proxy.ts: Stream Resolver & Track Pinning (💾 Сохранить навсегда)
import * as path from "@std/path";
import { config } from "./config.ts";
import { getDb, isTrackPinned, pinTrack, unpinTrack } from "./db.ts";
import { fetchAudioStream } from "./fetcher.ts";

export async function resolveTrackAudio(trackId: number): Promise<{
  ready: boolean;
  filePath?: string;
  source: string;
  error?: string;
}> {
  const db = getDb();
  const track = db.prepare(`SELECT id, path, title, artist, ytdl_id FROM tracks WHERE id = ?`).get(trackId) as {
    id: number;
    path: string;
    title: string;
    artist: string;
    ytdl_id?: string;
  } | undefined;

  if (!track) {
    return { ready: false, source: "unknown", error: `Track ${trackId} not found in database` };
  }

  // 1. Check if path already exists on disk
  if (track.path && await Deno.stat(track.path).then(() => true).catch(() => false)) {
    return { ready: true, filePath: track.path, source: "disk" };
  }

  // 2. Not on disk: Fetch immediately with direct ytdl_id priority
  let preferredYtdlId = track.ytdl_id;
  if (!preferredYtdlId) {
    try {
      const ext = db.prepare(`
        SELECT ytdl_id FROM external_catalog 
        WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
          AND ytdl_id IS NOT NULL AND length(ytdl_id) >= 11
        LIMIT 1
      `).get(track.artist, track.title) as { ytdl_id?: string } | undefined;
      if (ext?.ytdl_id) preferredYtdlId = ext.ytdl_id;
    } catch {}
  }

  const query = `${track.artist} - ${track.title}`.trim();
  console.log(`[stream-resolver] On-demand fetching Track ${trackId}: "${query}" (ytdl_id: ${preferredYtdlId || "searching"})...`);

  const res = await fetchAudioStream(query, { mode: "cache", preferredYtdlId });
  if (res.success && res.filePath) {
    if (res.ytdlId && (!track.ytdl_id || track.ytdl_id === "")) {
      try {
        db.prepare(`UPDATE tracks SET ytdl_id = ? WHERE id = ?`).run(res.ytdlId, trackId);
      } catch {}
    }
    return { ready: true, filePath: res.filePath, source: res.source };
  }

  return { ready: false, source: res.source, error: res.error || "Stream resolution failed" };
}

// 💾 Сохранить навсегда (Pin track to permanent storage)
export async function pinTrackForever(trackId: number): Promise<{
  success: boolean;
  permanentPath?: string;
  error?: string;
}> {
  const db = getDb();
  const track = db.prepare(`SELECT id, path, title, artist FROM tracks WHERE id = ?`).get(trackId) as {
    id: number;
    path: string;
    title: string;
    artist: string;
  } | undefined;

  if (!track) {
    return { success: false, error: `Track ID ${trackId} not found` };
  }

  await Deno.mkdir(config.favoritesDir, { recursive: true });

  // Ensure audio is on disk
  let currentAudioPath = track.path;
  const exists = currentAudioPath && await Deno.stat(currentAudioPath).then(() => true).catch(() => false);

  if (!exists) {
    // Download first
    const fetchRes = await fetchAudioStream(`${track.artist} - ${track.title}`, { mode: "pin" });
    if (!fetchRes.success || !fetchRes.filePath) {
      return { success: false, error: `Could not download audio to pin: ${fetchRes.error}` };
    }
    currentAudioPath = fetchRes.filePath;
  }

  const filename = path.basename(currentAudioPath);
  const permPath = path.resolve(config.favoritesDir, filename);

  // If currently in dynamic cache, move to favorites folder
  if (path.resolve(currentAudioPath) !== permPath) {
    try {
      await Deno.copyFile(currentAudioPath, permPath);
      // Update DB path
      db.prepare(`UPDATE tracks SET path = ? WHERE id = ?`).run(permPath, trackId);
    } catch (e) {
      return { success: false, error: `Failed to move audio to permanent storage: ${e}` };
    }
  }

  // Record in pinned_tracks
  pinTrack(trackId, db);
  console.log(`[pin] Track ${trackId} ("${track.title}") pinned forever to: ${permPath}`);

  return { success: true, permanentPath: permPath };
}

export function unpinTrackFromStorage(trackId: number): { success: boolean } {
  unpinTrack(trackId);
  return { success: true };
}
