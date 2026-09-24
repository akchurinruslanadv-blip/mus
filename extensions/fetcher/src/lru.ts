// extensions/fetcher/src/lru.ts: 3 GB Dynamic Cache Manager & Pinning Protection
import * as path from "@std/path";
import { config } from "./config.ts";
import { getDb, getAllPinnedTrackIds, getActiveSession } from "./db.ts";
import { CacheStats, EvictionResult } from "./types.ts";

export async function getCacheStats(
  dynamicDir = config.dynamicDir,
  maxGb = config.cacheMaxGb
): Promise<CacheStats> {
  let totalBytes = 0;
  let trackCount = 0;

  try {
    for await (const entry of Deno.readDir(dynamicDir)) {
      if (entry.isFile) {
        const fullPath = path.join(dynamicDir, entry.name);
        try {
          const stat = await Deno.stat(fullPath);
          totalBytes += stat.size;
          trackCount++;
        } catch {
          // File might be in transition
        }
      }
    }
  } catch {
    // Dynamic dir may not exist yet
  }

  const maxMb = maxGb * 1024;
  const totalMb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
  const usagePercent = Math.round((totalMb / maxMb) * 1000) / 10;
  const db = getDb();
  const pinnedIds = getAllPinnedTrackIds(db);

  let embedded512Count = 0;
  try {
    const featRow = db.prepare(`SELECT count(*) as c FROM features WHERE embedding IS NOT NULL AND status = 'ready'`).get() as { c: number } | undefined;
    embedded512Count = featRow?.c || 0;
  } catch {}

  let catalogCount = 0;
  try {
    const catRow = db.prepare(`SELECT count(*) as c FROM external_catalog`).get() as { c: number } | undefined;
    catalogCount = catRow?.c || 0;
  } catch {}

  return {
    trackCount,
    totalBytes,
    totalMb,
    maxMb,
    usagePercent,
    pinnedCount: pinnedIds.size,
    embedded512Count,
    catalogCount
  };
}

/**
 * Purges files in dynamic directory that are not tracked in tracks table.
 * Prevents phantom/orphan audio accumulation from hogging disk space.
 */
export async function purgeOrphanAudioFiles(dynamicDir = config.dynamicDir): Promise<{ deletedCount: number; freedBytes: number }> {
  const db = getDb();
  const knownBasenames = new Set<string>();

  try {
    const rows = db.prepare(`SELECT path FROM tracks WHERE path IS NOT NULL`).all() as { path: string }[];
    for (const r of rows) {
      if (r.path) {
        const base = path.basename(r.path).toLowerCase();
        knownBasenames.add(base);
      }
    }
  } catch {}

  let deletedCount = 0;
  let freedBytes = 0;

  try {
    for await (const entry of Deno.readDir(dynamicDir)) {
      if (entry.isFile) {
        const base = entry.name.toLowerCase();
        // If file is not in tracks database, it's an unindexed orphan
        if (!knownBasenames.has(base)) {
          const fullPath = path.join(dynamicDir, entry.name);
          try {
            const stat = await Deno.stat(fullPath);
            await Deno.remove(fullPath);
            deletedCount++;
            freedBytes += stat.size;
          } catch {}
        }
      }
    }
  } catch {}

  if (deletedCount > 0) {
    console.log(`[lru-gc] Purged ${deletedCount} orphan files (${(freedBytes / 1024 / 1024).toFixed(1)} MB freed)`);
  }

  return { deletedCount, freedBytes };
}

export async function enforceLruCache(
  dynamicDir = config.dynamicDir,
  maxGb = config.cacheMaxGb
): Promise<EvictionResult> {
  // First sweep unindexed orphan files before touching real tracks
  await purgeOrphanAudioFiles(dynamicDir);

  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const targetBytes = maxBytes * 0.85; // Clean down to 85% to avoid constant thrashing

  const db = getDb();
  const pinnedTrackIds = getAllPinnedTrackIds(db);
  const activeSession = getActiveSession(db);

  // Protected IDs from eviction:
  // 1. Pinned tracks (💾 Сохранить навсегда)
  // 2. Currently playing track
  // 3. Next 3 tracks in active queue
  const protectedPaths = new Set<string>();

  if (activeSession) {
    if (activeSession.currentId) {
      const row = db.prepare(`SELECT path FROM tracks WHERE id = ?`).get(activeSession.currentId) as { path: string } | undefined;
      if (row?.path) protectedPaths.add(path.resolve(row.path));
    }
    for (const q of activeSession.queue.slice(0, 3)) {
      if (q.path) protectedPaths.add(path.resolve(q.path));
    }
  }

  // Add all pinned tracks to protected paths
  for (const pid of pinnedTrackIds) {
    const row = db.prepare(`SELECT path FROM tracks WHERE id = ?`).get(pid) as { path: string } | undefined;
    if (row?.path) protectedPaths.add(path.resolve(row.path));
  }



  // 5. Explicitly protect any track that has not yet had its 512D CLAP embedding computed
  try {
    const pendingEmbedTracks = db.prepare(`
      SELECT t.path 
      FROM tracks t 
      LEFT JOIN features f ON f.track_id = t.id 
      WHERE f.embedding IS NULL OR f.status != 'ready'
    `).all() as { path: string }[];
    for (const t of pendingEmbedTracks) {
      if (t.path) protectedPaths.add(path.resolve(t.path));
    }
  } catch {}

  const files: { name: string; fullPath: string; size: number; accessTime: number }[] = [];
  let totalBytes = 0;

  try {
    for await (const entry of Deno.readDir(dynamicDir)) {
      if (entry.isFile) {
        const fullPath = path.resolve(path.join(dynamicDir, entry.name));
        try {
          const stat = await Deno.stat(fullPath);
          totalBytes += stat.size;
          const accessTime = stat.atime ? stat.atime.getTime() : (stat.mtime ? stat.mtime.getTime() : 0);
          files.push({
            name: entry.name,
            fullPath,
            size: stat.size,
            accessTime
          });
        } catch {
          // File may be locked
        }
      }
    }
  } catch {
    return { evictedFiles: [], freedBytes: 0, remainingBytes: 0 };
  }

  if (totalBytes <= maxBytes) {
    return {
      evictedFiles: [],
      freedBytes: 0,
      remainingBytes: totalBytes
    };
  }

  // Sort oldest access first (LRU)
  files.sort((a, b) => a.accessTime - b.accessTime);

  const evicted: string[] = [];
  let freed = 0;

  for (const file of files) {
    if (totalBytes - freed <= targetBytes) {
      break;
    }

    // Skip if in protected list (active queue or pinned)
    if (protectedPaths.has(file.fullPath)) {
      continue;
    }

    try {
      await Deno.remove(file.fullPath);
      evicted.push(file.name);
      freed += file.size;

      // Note: We deliberately DO NOT delete the row in `tracks` or `features`!
      // The 512D embedding and YouTube Music metadata remain in SQLite forever.
      console.log(`[lru] Evicted audio file ${file.name} to preserve 3 GB limit (${(file.size / 1024 / 1024).toFixed(1)} MB freed)`);
    } catch (e) {
      console.error(`[lru] Failed to evict file ${file.name}:`, e);
    }
  }

  return {
    evictedFiles: evicted,
    freedBytes: freed,
    remainingBytes: totalBytes - freed
  };
}

export async function cleanCacheNow(
  dynamicDir = config.dynamicDir,
  targetRatio = 0.5 // Clean down to 50% on manual request
): Promise<EvictionResult> {
  const stats = await getCacheStats(dynamicDir);
  const targetBytes = stats.totalBytes * targetRatio;

  const db = getDb();
  const pinnedTrackIds = getAllPinnedTrackIds(db);
  const activeSession = getActiveSession(db);

  const protectedPaths = new Set<string>();
  if (activeSession) {
    if (activeSession.currentId) {
      const row = db.prepare(`SELECT path FROM tracks WHERE id = ?`).get(activeSession.currentId) as { path: string } | undefined;
      if (row?.path) protectedPaths.add(path.resolve(row.path));
    }
    for (const q of activeSession.queue.slice(0, 3)) {
      if (q.path) protectedPaths.add(path.resolve(q.path));
    }
  }
  for (const pid of pinnedTrackIds) {
    const row = db.prepare(`SELECT path FROM tracks WHERE id = ?`).get(pid) as { path: string } | undefined;
    if (row?.path) protectedPaths.add(path.resolve(row.path));
  }



  // Explicitly protect any track that has not yet had its 512D CLAP embedding computed
  try {
    const pendingEmbedTracks = db.prepare(`
      SELECT t.path 
      FROM tracks t 
      LEFT JOIN features f ON f.track_id = t.id 
      WHERE f.embedding IS NULL OR f.status != 'ready'
    `).all() as { path: string }[];
    for (const t of pendingEmbedTracks) {
      if (t.path) protectedPaths.add(path.resolve(t.path));
    }
  } catch {}

  const files: { name: string; fullPath: string; size: number; accessTime: number }[] = [];
  try {
    for await (const entry of Deno.readDir(dynamicDir)) {
      if (entry.isFile) {
        const fullPath = path.resolve(path.join(dynamicDir, entry.name));
        try {
          const stat = await Deno.stat(fullPath);
          const accessTime = stat.atime ? stat.atime.getTime() : (stat.mtime ? stat.mtime.getTime() : 0);
          files.push({ name: entry.name, fullPath, size: stat.size, accessTime });
        } catch {}
      }
    }
  } catch {
    return { evictedFiles: [], freedBytes: 0, remainingBytes: 0 };
  }

  files.sort((a, b) => a.accessTime - b.accessTime);

  const evicted: string[] = [];
  let freed = 0;
  for (const file of files) {
    if (stats.totalBytes - freed <= targetBytes) break;
    if (protectedPaths.has(file.fullPath)) continue;

    try {
      await Deno.remove(file.fullPath);
      evicted.push(file.name);
      freed += file.size;
    } catch {}
  }

  return {
    evictedFiles: evicted,
    freedBytes: freed,
    remainingBytes: stats.totalBytes - freed
  };
}
