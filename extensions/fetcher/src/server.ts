// extensions/fetcher/src/server.ts: Sidecar HTTP API Server
import * as path from "@std/path";
import { config } from "./config.ts";
import { 
  getDb, 
  addIngestionTasks, 
  clearIngestionQueue, 
  get512DCandidates, 
  getUnheard512DCandidates,
  getFavoriteCandidates,
  isFavorite,
  isTrackFamiliar,
  getActiveSession,
  updateSessionQueue, 
  resetSessionExcludeIfExhausted,
  setDiscoveryRatio,
  getRadioSettings,
  setRadioSettings,
  upsertTrack
} from "./db.ts";
import { fetchAudioStream, updateYtDlp, searchOnlineTracks } from "./fetcher.ts";
import { getCacheStats, enforceLruCache, cleanCacheNow } from "./lru.ts";
import { startQueueWatcher } from "./queue_watcher.ts";
import { resolveTrackAudio, pinTrackForever, unpinTrackFromStorage } from "./stream_proxy.ts";
import { 
  find12DCandidates, 
  getColdStartSeeds, 
  findPredictiveCatalogTracks, 
  searchExternalCatalog,
  syncAllLocalTracksTo12DCatalog,
  resolveSeedAcousticFeatures 
} from "./dataset_bridge.ts";
import { ingestionWorker } from "./ingestion_worker.ts";
import { radioPoolManager } from "./radio_pool.ts";
import { AcousticFeatures12D } from "./types.ts";

// Start background workers
startQueueWatcher();
ingestionWorker.start();
radioPoolManager.start();

// Automatically project all local 512D tracks into 12D catalog in background
setTimeout(() => {
  try {
    syncAllLocalTracksTo12DCatalog();
  } catch (err) {
    console.error("[12D-bridge] Startup sync error:", err);
  }
}, 1000);

// P2: Automatic yt-dlp update check on startup if enabled
if (config.autoUpdateYtdlp) {
  updateYtDlp().catch(err => console.warn("[yt-dlp] Startup update failed:", err));
}

console.log(`=======================================================`);
console.log(` Starting musik-fetcher Sidecar API...`);
console.log(` Port: ${config.port}`);
console.log(` Dynamic Cache: ${config.dynamicDir} (Limit: ${config.cacheMaxGb} GB)`);
console.log(` Permanent Storage: ${config.favoritesDir}`);
console.log(` Database: ${config.dbPath}`);
console.log(`=======================================================`);

// Session recent tracks tracking to avoid repetitive recommendations
const sessionRecentMap = new Map<string, number[]>();

// Currently active on-demand audio downloads for UI progress display
const activeStreamDownloads = new Map<number, { startedAt: number; query: string }>();

// In-memory cache for GET /api/favorites (avoids 700ms 550KB SQLite serialization on every like/load)
let cachedFavoritesResponse: string | null = null;
let lastFavoritesCacheTime = 0;

// Fast retrieval of an authentic track whose audio is guaranteed to be on disk
function getHotStartingTrack(db = getDb()): { id: number; artist: string; title: string; album: string; path: string; duration: number } | null {
  // 1. Try to pick from on-disk favorites first (familiar taste)
  const favCandidates = db.prepare(`
    SELECT t.id, t.artist, t.title, t.album, t.path, t.duration
    FROM favorites f
    JOIN tracks t ON f.track_id = t.id
    WHERE t.is_active = 1 AND t.path IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 30
  `).all() as any[];

  for (const c of favCandidates) {
    try {
      if (c.path) {
        const s = Deno.statSync(c.path);
        if (s.isFile && s.size > 100000) return c;
      }
    } catch {}
  }

  // 2. Fallback: Any active track with existing audio file on disk
  const anyCandidates = db.prepare(`
    SELECT t.id, t.artist, t.title, t.album, t.path, t.duration
    FROM tracks t
    WHERE t.is_active = 1 AND t.path IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 50
  `).all() as any[];

  for (const c of anyCandidates) {
    try {
      if (c.path) {
        const s = Deno.statSync(c.path);
        if (s.isFile && s.size > 100000) return c;
      }
    } catch {}
  }

  return null;
}

// Builder for dynamic balanced queue honoring user's discoveryRatio and 12D mood biases
function buildBalancedRadioQueue(currentTrackId: number, count = 6, excludeRecentIds: number[] = [], sessionId = "default"): any[] {
  const tQueueStart = performance.now();
  const db = getDb();
  const settings = getRadioSettings(sessionId, db);
  const ratio = settings.discoveryRatio;
  const biases = settings.biases;
  const targetDiscovery = Math.round(count * ratio);
  const targetFavorites = count - targetDiscovery;

  const queue: any[] = [];
  const selectedIds = new Set<number>([currentTrackId, ...excludeRecentIds]);

  // Seed features from current track (direct catalog match or closest 512D acoustic donor)
  const seedFeatures: AcousticFeatures12D = currentTrackId
    ? resolveSeedAcousticFeatures(currentTrackId, db)
    : {
        danceability: 0.55,
        energy: 0.55,
        key: 0,
        loudness: -8,
        mode: 1,
        speechiness: 0.05,
        acousticness: 0.25,
        instrumentalness: 0.05,
        liveness: 0.1,
        valence: 0.5,
        tempo: 115
      };

  // 1. Gather Favorite candidates
  let favCandidates: any[] = [];
  if (targetFavorites > 0) {
    favCandidates = getFavoriteCandidates(Array.from(selectedIds), targetFavorites * 2, db);
    // If not enough favorites in library, fall back to general 512D library tracks
    if (favCandidates.length < targetFavorites) {
      const extraLib = get512DCandidates(Array.from(selectedIds), targetFavorites - favCandidates.length, db);
      favCandidates.push(...extraLib);
    }
  }

  // 2. Gather Discovery candidates directly driven by active acoustic biases
  let discCandidates: any[] = [];
  if (targetDiscovery > 0) {
    const hasBiases = biases && (
      (biases.energy && Math.abs(biases.energy) > 0.04) ||
      (biases.valence && Math.abs(biases.valence) > 0.04) ||
      (biases.acousticness && Math.abs(biases.acousticness) > 0.04) ||
      (biases.tempo && Math.abs(biases.tempo) > 0.04)
    );

    const excludeTitles = new Set<string>();
    try {
      const rows = db.prepare(`SELECT artist, title FROM tracks WHERE id IN (${Array.from(selectedIds).join(",") || "0"})`).all() as { artist: string; title: string }[];
      for (const r of rows) excludeTitles.add(`${r.artist} - ${r.title}`.toLowerCase());
    } catch {}

    // A. Check ready items from radio pool (pre-downloaded, 512D-scored against centroid)
    // getReadyPool() returns candidates sorted by 512D taste similarity score descending
    const readyPool = radioPoolManager.getReadyPool().filter(c =>
      c.trackId &&
      !selectedIds.has(c.trackId) &&
      !isTrackFamiliar(c.trackId, db)
    );
    for (const pc of readyPool) {
      if (discCandidates.length >= targetDiscovery) break;
      discCandidates.push({
        track_id: pc.trackId,
        artist: pc.artist,
        title: pc.title,
        album: "Radio Discovery",
        path: pc.filePath || "",
        duration: 180,
        score: pc.score || 0.85,
        explanation: pc.explanation || "🧠 512D акустическое открытие",
        explore: true,
        new_boost: true,
        cluster_id: -1
      });
      selectedIds.add(pc.trackId!);
    }

    // B. Unheard 512D library candidates (tracks with ready 512D embeddings, never listened to)
    if (discCandidates.length < targetDiscovery) {
      const needed = targetDiscovery - discCandidates.length;
      const unheardLib = getUnheard512DCandidates(Array.from(selectedIds), needed * 2, db);
      for (const cand of unheardLib) {
        if (discCandidates.length >= targetDiscovery) break;
        discCandidates.push(cand);
        selectedIds.add(cand.track_id);
      }
    }

    // C. Direct 12D Catalog candidate generation if still below target (honoring user biases)
    if (discCandidates.length < targetDiscovery) {
      const needed = targetDiscovery - discCandidates.length;
      const hits = find12DCandidates(seedFeatures, needed * 2, excludeTitles, db, biases);
      for (const hit of hits) {
        if (discCandidates.length >= targetDiscovery) break;
        const safeName = `${hit.artist} - ${hit.title}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
        const targetPath = path.join(config.dynamicDir, `${safeName}.webm`);
        const trackId = upsertTrack({
          path: targetPath,
          title: hit.title,
          artist: hit.artist,
          album: hit.album || "Radio Discovery",
          duration: 180,
          ytdlId: hit.ytdlId
        }, db);

        discCandidates.push({
          track_id: trackId,
          artist: hit.artist,
          title: hit.title,
          album: hit.album || "Radio Discovery",
          path: targetPath,
          duration: 180,
          score: hit.similarity,
          explanation: hit.reason || "12D подбор настроения",
          explore: true,
          new_boost: true,
          cluster_id: -1
        });
        selectedIds.add(trackId);
        excludeTitles.add(`${hit.artist} - ${hit.title}`.toLowerCase());
      }
    }
  }

  // 3. Interleave or combine according to ratio
  let favIdx = 0;
  let discIdx = 0;
  while (queue.length < count && (favIdx < favCandidates.length || discIdx < discCandidates.length)) {
    if (ratio >= 0.7) {
      if (discIdx < discCandidates.length) queue.push(discCandidates[discIdx++]);
      else if (favIdx < favCandidates.length) queue.push(favCandidates[favIdx++]);
    } else if (ratio <= 0.3) {
      if (favIdx < favCandidates.length) queue.push(favCandidates[favIdx++]);
      else if (discIdx < discCandidates.length) queue.push(discCandidates[discIdx++]);
    } else {
      if (discIdx < discCandidates.length && (queue.length % 2 === 1 || favIdx >= favCandidates.length)) {
        queue.push(discCandidates[discIdx++]);
      } else if (favIdx < favCandidates.length) {
        queue.push(favCandidates[favIdx++]);
      } else if (discIdx < discCandidates.length) {
        queue.push(discCandidates[discIdx++]);
      }
    }
  }

  // Zero-Stall Guarantee: Ensure the immediate next 2 tracks (queue[0] and queue[1]) are 100% ready on disk.
  // This guarantees that single or double-skipping starts playing instantly (0ms latency),
  // while the background queue watcher pre-fetches queue[2] and queue[3].
  if (queue.length > 0) {
    const isReadySync = (item: any): boolean => {
      if (!item?.path) return false;
      try {
        const s = Deno.statSync(item.path);
        return s.isFile && s.size > 100000;
      } catch {
        return false;
      }
    };

    const slotsToCheck = Math.min(2, queue.length);
    for (let slot = 0; slot < slotsToCheck; slot++) {
      if (!isReadySync(queue[slot])) {
        const readyIdx = queue.findIndex((item, idx) => idx > slot && isReadySync(item));
        if (readyIdx > slot) {
          const [readyTrack] = queue.splice(readyIdx, 1);
          queue.splice(slot, 0, readyTrack);
        } else {
          const readyPoolCand = radioPoolManager.getReadyPool().find(c => c.trackId && !selectedIds.has(c.trackId) && !queue.some(q => q.track_id === c.trackId));
          if (readyPoolCand && readyPoolCand.trackId) {
            queue.splice(slot, 0, {
              track_id: readyPoolCand.trackId,
              artist: readyPoolCand.artist,
              title: readyPoolCand.title,
              album: "Radio Discovery",
              path: readyPoolCand.filePath || "",
              duration: 180,
              score: readyPoolCand.score || 0.85,
              explanation: readyPoolCand.explanation || "🧠 Горячий трек из пула",
              explore: true,
              new_boost: true,
              cluster_id: -1
            });
            selectedIds.add(readyPoolCand.trackId);
          } else {
            const hot = getHotStartingTrack(db);
            if (hot && !selectedIds.has(hot.id) && !queue.some(q => q.track_id === hot.id)) {
              queue.splice(slot, 0, {
                track_id: hot.id,
                artist: hot.artist,
                title: hot.title,
                album: hot.album,
                path: hot.path,
                duration: hot.duration,
                score: 0.9,
                explanation: "Готовый трек (Zero-Stall)",
                explore: false,
                new_boost: false,
                cluster_id: -1
              });
              selectedIds.add(hot.id);
            }
          }
        }
      }
    }
  }

  const tQueueTotal = performance.now() - tQueueStart;
  console.log(`[timing] Balanced radio queue generated in ${tQueueTotal.toFixed(1)}ms (${queue.length} tracks, ratio: ${ratio})`);

  return queue;
}


Deno.serve({ port: config.port }, async (req: Request) => {
  const url = new URL(req.url);

  // CORS headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // Health
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "musik-fetcher",
      version: "2.1.0",
      cache_limit_gb: config.cacheMaxGb,
      ingestion_worker_active: true,
      radio_pool_active: true
    }), { headers });
  }

  // 1. Cache Stats
  if (url.pathname === "/api/v1/cache" && req.method === "GET") {
    const stats = await getCacheStats();
    return new Response(JSON.stringify(stats), { headers });
  }

  // 2. Trigger LRU Cache Clean (Manual safe sweep down to 50%)
  if (url.pathname === "/api/v1/cache/clean" && req.method === "POST") {
    const res = await cleanCacheNow();
    return new Response(JSON.stringify(res), { headers });
  }

  // 3. On-demand Fetch Track
  if (url.pathname === "/api/v1/fetch" && req.method === "POST") {
    try {
      const body = await req.json();
      const query = body.query || `${body.artist || ""} ${body.title || ""}`.trim();
      const mode = body.mode === "pin" ? "pin" : "cache";
      if (!query) {
        return new Response(JSON.stringify({ error: "Missing query or artist+title" }), { status: 400, headers });
      }

      const res = await fetchAudioStream(query, { mode });
      return new Response(JSON.stringify(res), { status: res.success ? 200 : 500, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers });
    }
  }

  // 4. Resolve Stream Audio for Track ID
  const resolveMatch = url.pathname.match(/^\/api\/v1\/tracks\/(\d+)\/resolve$/);
  if (resolveMatch && req.method === "GET") {
    const trackId = parseInt(resolveMatch[1]);
    const res = await resolveTrackAudio(trackId);
    return new Response(JSON.stringify(res), { status: res.ready ? 200 : 404, headers });
  }

  // 4.1 Track Download & Buffering Status (Display loading progress in UI)
  const statusMatch = url.pathname.match(/^\/api\/v1\/tracks\/(\d+)\/status$/);
  if (statusMatch && req.method === "GET") {
    const trackId = parseInt(statusMatch[1], 10);
    const db = getDb();
    const tRow = db.prepare(`SELECT path, title, artist, file_size FROM tracks WHERE id = ?`).get(trackId) as any;
    let onDisk = false;
    if (tRow?.path) {
      try { onDisk = Deno.statSync(tRow.path).isFile; } catch {}
    }
    const isDownloading = activeStreamDownloads.has(trackId);
    const dlInfo = activeStreamDownloads.get(trackId);
    return new Response(JSON.stringify({
      track_id: trackId,
      on_disk: onDisk,
      is_downloading: isDownloading,
      elapsed_ms: dlInfo ? Date.now() - dlInfo.startedAt : 0,
      title: tRow?.title || "",
      artist: tRow?.artist || ""
    }), { headers });
  }

  // 5. Pin Track (💾 Сохранить навсегда)
  const pinMatch = url.pathname.match(/^\/api\/v1\/tracks\/(\d+)\/pin$/);
  if (pinMatch) {
    const trackId = parseInt(pinMatch[1]);
    if (req.method === "POST") {
      const res = await pinTrackForever(trackId);
      return new Response(JSON.stringify(res), { status: res.success ? 200 : 500, headers });
    }
    if (req.method === "DELETE") {
      const res = unpinTrackFromStorage(trackId);
      return new Response(JSON.stringify(res), { headers });
    }
  }

  // 5.4 Track Undislike (Remove / Undo Dislike)
  const undislikeMatch = url.pathname.match(/^\/api\/v1\/tracks\/(\d+)\/undislike$/);
  if (undislikeMatch && req.method === "POST") {
    const trackId = parseInt(undislikeMatch[1]);
    const db = getDb();
    try {
      db.prepare(`DELETE FROM listening_history WHERE track_id = ? AND action = 'dislike'`).run(trackId);
      return new Response(JSON.stringify({ success: true, undisliked: true, track_id: trackId }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  // 5.5 Radio Listening History (Unlimited & Cached for Instant 0.1ms UI)
  if ((url.pathname === "/api/v1/radio/history" || url.pathname === "/api/history") && req.method === "GET") {
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam) : -1; // -1 = All tracks
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const query = (url.searchParams.get("q") || "").trim();
    const db = getDb();
    try {
      let sql: string;
      const params: any[] = [];
      if (query) {
        sql = `
          SELECT 
            t.id, t.artist, t.title, t.duration,
            h.max_ts as played_at,
            (SELECT action FROM listening_history WHERE track_id = t.id AND ts = h.max_ts LIMIT 1) as action,
            EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
            EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
            (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
            EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
            CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
          FROM (
            SELECT track_id, MAX(ts) as max_ts
            FROM listening_history
            WHERE action IN ('start', 'track_end', 'skip', 'progress')
            GROUP BY track_id
          ) h
          JOIN tracks t ON t.id = h.track_id
          WHERE (t.artist LIKE ? OR t.title LIKE ?)
          ORDER BY h.max_ts DESC
          LIMIT ? OFFSET ?
        `;
        params.push(`%${query}%`, `%${query}%`, limit, offset);
      } else {
        const subLimit = limit;
        sql = `
          SELECT 
            t.id, t.artist, t.title, t.duration,
            h.max_ts as played_at,
            (SELECT action FROM listening_history WHERE track_id = t.id AND ts = h.max_ts LIMIT 1) as action,
            EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
            EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
            (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
            EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
            CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
          FROM (
            SELECT track_id, MAX(ts) as max_ts
            FROM listening_history
            WHERE action IN ('start', 'track_end', 'skip', 'progress')
            GROUP BY track_id
            ORDER BY max_ts DESC
            LIMIT ? OFFSET ?
          ) h
          JOIN tracks t ON t.id = h.track_id
          ORDER BY h.max_ts DESC
        `;
        params.push(subLimit, offset);
      }

      const rows = db.prepare(sql).all(...params);
      return new Response(JSON.stringify({ history: rows, count: rows.length, unlimited: limit === -1 }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e), history: [] }), { headers });
    }
  }

  // 5.6 Track Origin Lookup (Single & Batch)
  const trackOriginMatch = url.pathname.match(/^\/api\/v1\/tracks\/(\d+)\/origin$/);
  if (trackOriginMatch && req.method === "GET") {
    const trackId = parseInt(trackOriginMatch[1], 10);
    const db = getDb();
    try {
      const row = db.prepare(`
        SELECT 
          t.id,
          t.artist,
          t.title,
          EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
          EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
          EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
          EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
          (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
          EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
          CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
        FROM tracks t
        WHERE t.id = ?
      `).get(trackId);
      return new Response(JSON.stringify(row || { id: trackId }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  if (url.pathname === "/api/v1/tracks/origins" && req.method === "POST") {
    try {
      const body = await req.json();
      const ids: number[] = (body.ids || []).filter((id: any) => typeof id === "number");
      const queries: { artist?: string; title?: string }[] = (body.queries || []).filter((q: any) => q && (q.title || q.artist));

      const db = getDb();
      const origins: Record<number, any> = {};
      const originsByQuery: Record<string, any> = {};

      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`
          SELECT 
            t.id,
            t.artist,
            t.title,
            t.path,
            EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
            EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
            EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
            (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
            EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
            CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
          FROM tracks t
          WHERE t.id IN (${placeholders})
        `).all(...ids) as any[];

        const activeTask = radioPoolManager.getActiveTask();
        for (const r of rows) {
          let onDisk = false;
          if (r.path) {
            try {
              const st = Deno.statSync(r.path);
              onDisk = st.isFile && st.size > 100000;
            } catch {}
          }
          r.on_disk = onDisk;
          r.is_downloading = activeStreamDownloads.has(r.id) || (activeTask?.trackId === r.id && activeTask?.stage === "downloading");
          r.is_vectorizing = (activeTask?.trackId === r.id && activeTask?.stage === "vectorizing");

          origins[r.id] = r;
          const k = `${r.artist || ""}|||${r.title || ""}`.toLowerCase();
          originsByQuery[k] = r;
        }
      }

      if (queries.length > 0) {
        const activeTask = radioPoolManager.getActiveTask();
        for (const q of queries) {
          const k = `${q.artist || ""}|||${q.title || ""}`.toLowerCase();
          if (originsByQuery[k]) continue;

          let row: any = null;
          if (q.artist && q.title) {
            row = db.prepare(`
              SELECT 
                t.id, t.artist, t.title, t.path,
                EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
                EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
                EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
                EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
                (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
                EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
                CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
              FROM tracks t
              WHERE t.artist = ? AND t.title = ?
              LIMIT 1
            `).get(q.artist, q.title);
          }
          if (!row && q.title) {
            row = db.prepare(`
              SELECT 
                t.id, t.artist, t.title, t.path,
                EXISTS(SELECT 1 FROM pinned_tracks WHERE track_id = t.id) as is_pinned,
                EXISTS(SELECT 1 FROM favorites WHERE track_id = t.id) as is_favorite,
                EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 512) as has_512d,
                EXISTS(SELECT 1 FROM features WHERE track_id = t.id AND embedding_dim = 12) as in_12d,
                (SELECT pl.name FROM playlist_tracks pt JOIN playlists pl ON pl.id = pt.playlist_id WHERE pt.track_id = t.id LIMIT 1) as playlist_name,
                EXISTS(SELECT 1 FROM ingestion_queue WHERE track_id = t.id) as is_imported,
                CASE WHEN t.path NOT LIKE '%dynamic%' THEN 1 ELSE 0 END as is_local
              FROM tracks t
              WHERE t.title = ?
              LIMIT 1
            `).get(q.title);
          }
          if (row) {
            let onDisk = false;
            if (row.path) {
              try {
                const st = Deno.statSync(row.path);
                onDisk = st.isFile && st.size > 100000;
              } catch {}
            }
            row.on_disk = onDisk;
            row.is_downloading = activeStreamDownloads.has(row.id) || (activeTask?.trackId === row.id && activeTask?.stage === "downloading");
            row.is_vectorizing = (activeTask?.trackId === row.id && activeTask?.stage === "vectorizing");

            origins[row.id] = row;
            originsByQuery[k] = row;
          }
        }
      }

      const curActive = radioPoolManager.getActiveTask();
      const readyPool = radioPoolManager.getReadyPool();
      const totalPool = radioPoolManager.getPool();

      return new Response(JSON.stringify({ 
        origins, 
        originsByQuery,
        pool_status: {
          ready_count: readyPool.length,
          total_count: totalPool.length,
          active_task: curActive ? {
            artist: curActive.artist,
            title: curActive.title,
            stage: curActive.stage
          } : null
        }
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ origins: {}, originsByQuery: {}, error: String(e) }), { headers });
    }
  }

  // 5.7 Radio Settings (Discovery Balance & Acoustic Vector Biases) - Persistent in SQLite per session/device
  if (url.pathname === "/api/v1/radio/settings" && req.method === "POST") {
    try {
      const body = await req.json();
      const db = getDb();
      const activeSession = getActiveSession(db);
      const sessionId = body.sessionId || body.session_id || (activeSession ? activeSession.id : "default");

      const saved = setRadioSettings(sessionId, {
        discoveryRatio: typeof body.discoveryRatio === "number" ? body.discoveryRatio : undefined,
        biases: body.biases
      }, db);

      if (sessionId !== "default") {
        setRadioSettings("default", {
          discoveryRatio: saved.discoveryRatio,
          biases: saved.biases
        }, db);
      }

      const curTrackId = activeSession?.currentId || (db.prepare(`SELECT track_id FROM listening_history ORDER BY ts DESC LIMIT 1`).get() as any)?.track_id || 1;
      const updatedQueue = buildBalancedRadioQueue(curTrackId, 6, [], sessionId);
      if (activeSession) {
        updateSessionQueue(activeSession.id, curTrackId, updatedQueue);
      }
      radioPoolManager.refreshPool(saved.biases).catch(() => {});

      return new Response(JSON.stringify({ 
        success: true, 
        settings: { ...saved, sessionId }, 
        queue: updatedQueue 
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers });
    }
  }

  if (url.pathname === "/api/v1/radio/settings" && req.method === "GET") {
    const db = getDb();
    const activeSession = getActiveSession(db);
    const sessionId = url.searchParams.get("session_id") || (activeSession ? activeSession.id : "default");
    const settings = getRadioSettings(sessionId, db);
    return new Response(JSON.stringify({ settings: { ...settings, sessionId } }), { headers });
  }

  // 5.8 Update yt-dlp Tooling (P2: Auto/Manual updater)
  if (url.pathname === "/api/v1/tools/update-ytdlp" && req.method === "POST") {
    const res = await updateYtDlp();
    return new Response(JSON.stringify(res), { status: res.success ? 200 : 500, headers });
  }


  // 6. Cold Start Seeds (for 0 tracks library)
  if (url.pathname === "/api/v1/catalog/seeds" && req.method === "GET") {
    const count = parseInt(url.searchParams.get("count") || "5");
    const seeds = getColdStartSeeds(count);
    return new Response(JSON.stringify({ count: seeds.length, seeds }), { headers });
  }

  // 7. 12D Catalog Blending
  if (url.pathname === "/api/v1/catalog/blend" && req.method === "POST") {
    try {
      const body = await req.json();
      const features = body.features;
      const limit = parseInt(body.limit || "5");
      if (!features) {
        return new Response(JSON.stringify({ error: "Missing 12D features" }), { status: 400, headers });
      }
      const candidates = find12DCandidates(features, limit);
      return new Response(JSON.stringify({ count: candidates.length, candidates }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers });
    }
  }

  // 7b. Predictive 512D Background Indexing of Catalog Tracks Matching User Taste
  if (url.pathname === "/api/v1/catalog/preindex-512" && req.method === "POST") {
    try {
      let count = 15;
      try {
        const body = await req.json();
        if (body.count) count = Math.min(50, Math.max(1, parseInt(body.count)));
      } catch {}

      const db = getDb();
      const settings = getRadioSettings("default", db);
      const candidates = findPredictiveCatalogTracks(count, db, settings.biases);
      if (candidates.length === 0) {
        return new Response(JSON.stringify({ success: false, message: "Нет доступных новых треков для оцифровки" }), { headers });
      }

      const tasks = candidates.map(c => ({
        artist: c.artist,
        title: c.title,
        addToFavorites: false, // Don't distort favorites
        pinForever: false,     // Managed cleanly by 3GB LRU cache
        autoEmbed512: true     // Digitized into 512D neural vector!
      }));

      const added = addIngestionTasks(tasks);
      ingestionWorker.resume();

      return new Response(JSON.stringify({ 
        success: true, 
        added, 
        candidates: candidates.map(c => ({
          track: `${c.artist} - ${c.title}`,
          genre: c.genre,
          affinity: Math.round(c.score * 100) + "%"
        }))
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  // 7c. Status of 512D Background Preindexing
  if (url.pathname === "/api/v1/catalog/preindex-status" && req.method === "GET") {
    const workerStatus = ingestionWorker.getStatus();
    const db = getDb();
    const total512 = (db.prepare(`SELECT count(*) as c FROM features`).get() as { c?: number })?.c || 0;
    const totalCatalog = (db.prepare(`SELECT count(*) as c FROM external_catalog`).get() as { c?: number })?.c || 0;

    return new Response(JSON.stringify({
      active: workerStatus.pending > 0 || workerStatus.processing > 0,
      workerStatus,
      total512,
      totalCatalog
    }), { headers });
  }

  // 7c2. Sync & Project Local 512D Tracks to 12D Catalog
  if (url.pathname === "/api/v1/catalog/sync-12d" && req.method === "POST") {
    try {
      const count = syncAllLocalTracksTo12DCatalog();
      return new Response(JSON.stringify({ success: true, projectedCount: count }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500, headers });
    }
  }

  // 7d. Instant Catalog Search (across 3.27M tracks)
  if (url.pathname === "/api/v1/catalog/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "40", 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
    const results = searchExternalCatalog(q, limit, offset);
    return new Response(JSON.stringify(results), { headers });
  }

  // 7d2. Online Search Fallback (Google & YouTube Music via yt-dlp)
  if (url.pathname === "/api/v1/catalog/search-online" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") || "8", 10)));
    if (!q) {
      return new Response(JSON.stringify({ count: 0, tracks: [], source: "google_youtube_music" }), { headers });
    }
    const onlineTracks = await searchOnlineTracks(q, limit);
    return new Response(JSON.stringify({ count: onlineTracks.length, tracks: onlineTracks, source: "google_youtube_music" }), { headers });
  }

  // 7e. Play Track from Catalog (on-demand resolve or playback)
  if (url.pathname === "/api/v1/catalog/play" && req.method === "POST") {
    try {
      const body = await req.json();
      const artist = (body.artist || "").trim();
      const title = (body.title || "").trim();
      const album = (body.album || "Catalog Stream").trim();
      const durationSec = Math.round(body.duration_sec || body.duration || 180);

      if (!artist || !title) {
        return new Response(JSON.stringify({ error: "Missing artist or title" }), { status: 400, headers });
      }

      const db = getDb();
      let trackId: number;

      // 1. Check if track already exists in tracks table
      let existing: { id: number; path: string } | undefined;
      if (body.track_id) {
        existing = db.prepare(`SELECT id, path FROM tracks WHERE id = ?`).get(body.track_id) as { id: number; path: string } | undefined;
      }
      if (!existing) {
        existing = db.prepare(`
          SELECT id, path FROM tracks 
          WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE
          LIMIT 1
        `).get(artist, title) as { id: number; path: string } | undefined;
      }
      if (!existing) {
        existing = db.prepare(`
          SELECT id, path FROM tracks 
          WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
          LIMIT 1
        `).get(artist, title) as { id: number; path: string } | undefined;
      }

      if (existing) {
        trackId = existing.id;
      } else {
        const safeName = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
        const targetPath = path.join(config.dynamicDir, `${safeName}.webm`);
        trackId = upsertTrack({
          path: targetPath,
          title,
          artist,
          album,
          duration: durationSec
        }, db);

        // Copy 12D acoustic features from external_catalog if available
        try {
          const cat = db.prepare(`
            SELECT features_json FROM external_catalog 
            WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
            LIMIT 1
          `).get(artist, title) as { features_json?: string } | undefined;

          if (cat?.features_json) {
            db.prepare(`
              INSERT INTO features (track_id, embedding_dim, vector, created_at)
              VALUES (?, 12, ?, ?)
              ON CONFLICT(track_id, embedding_dim) DO NOTHING
            `).run(trackId, cat.features_json, new Date().toISOString());
          }
        } catch {}

        try {
          await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
        } catch {}
      }

      return new Response(JSON.stringify({
        success: true,
        track_id: trackId,
        artist,
        title,
        streamUrl: `/api/stream/${trackId}`
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  // 7f. Add Catalog Track to Queue
  if (url.pathname === "/api/v1/catalog/queue" && req.method === "POST") {
    try {
      const body = await req.json();
      const artist = (body.artist || "").trim();
      const title = (body.title || "").trim();
      const album = (body.album || "Catalog Stream").trim();
      const durationSec = Math.round(body.duration_sec || body.duration || 180);

      if (!artist || !title) {
        return new Response(JSON.stringify({ error: "Missing artist or title" }), { status: 400, headers });
      }

      const db = getDb();
      let trackId: number;
      const existing = db.prepare(`
        SELECT id, path FROM tracks 
        WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
        LIMIT 1
      `).get(artist, title) as { id: number; path: string } | undefined;

      if (existing) {
        trackId = existing.id;
      } else {
        const safeName = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
        const targetPath = path.join(config.dynamicDir, `${safeName}.webm`);
        trackId = upsertTrack({
          path: targetPath,
          title,
          artist,
          album,
          duration: durationSec
        }, db);
      }

      // Add to session queue
      const activeSession = getActiveSession(db);
      const sessionId = body.sessionId || (activeSession ? activeSession.id : "default");
      const currentQueue = activeSession ? activeSession.queue : [];
      currentQueue.push({
        track_id: trackId,
        artist,
        title,
        album,
        duration: durationSec
      } as any);

      updateSessionQueue(sessionId, activeSession?.currentId || trackId, currentQueue, db);

      return new Response(JSON.stringify({
        success: true,
        track_id: trackId,
        queue: currentQueue
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  // 8. Ingestion Queue API (Import Playlist by titles)
  if (url.pathname === "/api/v1/import/playlist" && req.method === "POST") {
    try {
      const body = await req.json();
      const rawTracks = body.tracks || [];
      const addToFavorites = body.addToFavorites === true;
      const pinForever = body.pinForever === true;
      const autoEmbed512 = body.autoEmbed512 !== false; // default true

      const parsedTasks: { artist: string; title: string; addToFavorites: boolean; pinForever: boolean; autoEmbed512: boolean }[] = [];

      for (const item of rawTracks) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (!trimmed) continue;
          let artist = "Various Artists";
          let title = trimmed;
          if (trimmed.includes(" - ")) {
            const parts = trimmed.split(" - ");
            artist = parts[0].trim();
            title = parts.slice(1).join(" - ").trim();
          }
          parsedTasks.push({ artist, title, addToFavorites, pinForever, autoEmbed512 });
        } else if (item && typeof item === "object") {
          const artist = (item.artist || "").trim();
          const title = (item.title || "").trim();
          if (artist && title) {
            parsedTasks.push({ artist, title, addToFavorites, pinForever, autoEmbed512 });
          }
        }
      }

      const added = addIngestionTasks(parsedTasks);
      // Trigger worker step immediately
      ingestionWorker.step().catch(() => {});

      return new Response(JSON.stringify({
        success: true,
        addedCount: added,
        options: { addToFavorites, pinForever, autoEmbed512 }
      }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers });
    }
  }

  if (url.pathname === "/api/v1/import/status" && req.method === "GET") {
    const status = ingestionWorker.getStatus();
    return new Response(JSON.stringify(status), { headers });
  }

  if (url.pathname === "/api/v1/import/pause" && req.method === "POST") {
    ingestionWorker.pause();
    return new Response(JSON.stringify({ success: true, isPaused: true }), { headers });
  }

  if (url.pathname === "/api/v1/import/resume" && req.method === "POST") {
    ingestionWorker.resume();
    return new Response(JSON.stringify({ success: true, isPaused: false }), { headers });
  }

  if (url.pathname === "/api/v1/import/clear" && req.method === "POST") {
    clearIngestionQueue();
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  if (url.pathname === "/api/v1/import/items" && req.method === "GET") {
    const status = url.searchParams.get("status") || "all";
    const q = (url.searchParams.get("q") || "").trim();
    const limit = parseInt(url.searchParams.get("limit") || "40");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const db = getDb();

    let sql = `SELECT id, artist, title, status, track_id, error, created_at, completed_at FROM ingestion_queue WHERE 1=1`;
    const params: any[] = [];
    if (status !== "all") {
      sql += ` AND status = ?`;
      params.push(status);
    }
    if (q) {
      sql += ` AND (artist LIKE ? OR title LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ` ORDER BY id ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const items = db.prepare(sql).all(...params);
    let countSql = `SELECT count(*) as total FROM ingestion_queue WHERE 1=1`;
    const countParams: any[] = [];
    if (status !== "all") {
      countSql += ` AND status = ?`;
      countParams.push(status);
    }
    if (q) {
      countSql += ` AND (artist LIKE ? OR title LIKE ?)`;
      countParams.push(`%${q}%`, `%${q}%`);
    }
    const totalRow = db.prepare(countSql).get(...countParams) as { total: number };

    return new Response(JSON.stringify({ items, total: totalRow.total }), { headers });
  }

  if (url.pathname === "/api/v1/import/unfavorite" && req.method === "POST") {
    const db = getDb();
    try {
      const res = db.prepare(`
        DELETE FROM favorites 
        WHERE track_id IN (SELECT track_id FROM ingestion_queue WHERE track_id IS NOT NULL)
      `).run();
      return new Response(JSON.stringify({ success: true, removedCount: typeof res === "number" ? res : (res as any)?.changes || 0 }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  }

  // 9. Speculative Radio Pool API
  if (url.pathname === "/api/v1/radio/pool" && req.method === "GET") {
    const pool = radioPoolManager.getPool();
    return new Response(JSON.stringify({ count: pool.length, pool }), { headers });
  }

  if (url.pathname === "/api/v1/radio/pool/refill" && req.method === "POST") {
    await radioPoolManager.maintainPool();
    const pool = radioPoolManager.getPool();
    return new Response(JSON.stringify({ count: pool.length, pool }), { headers });
  }

  // 10. Web UI Overlay Script Asset
  if (url.pathname === "/addon/ui.js" && req.method === "GET") {
    try {
      const scriptPath = path.join(path.dirname(path.fromFileUrl(import.meta.url)), "ui_overlay.js");
      const content = await Deno.readTextFile(scriptPath);
      return new Response(content, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache"
        }
      });
    } catch {
      return new Response("// UI overlay script", {
        headers: { "Content-Type": "application/javascript", "Access-Control-Allow-Origin": "*" }
      });
    }
  }

  // 11. Zero-Intrusion Proxy to Core Web Player with 512D Anti-Stall Guard
  try {
    const baseTarget = new URL(config.playerUrl);
    const upstreamUrl = new URL(req.url);
    upstreamUrl.protocol = baseTarget.protocol;
    upstreamUrl.hostname = baseTarget.hostname;
    upstreamUrl.port = baseTarget.port;

    const forwardHeaders = new Headers(req.headers);
    forwardHeaders.delete("host");
    forwardHeaders.delete("content-length");
    forwardHeaders.delete("connection");

    let reqBodyText: string | undefined = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        reqBodyText = await req.text();
      } catch {}
    }

    // 0. Intercept /api/stream/:id for On-Demand Audio Resolution & Range Support
    const streamMatch = url.pathname.match(/^\/api\/stream\/(\d+)$/);
    if (streamMatch && (req.method === "GET" || req.method === "HEAD")) {
      const tStreamStart = performance.now();
      const trackId = parseInt(streamMatch[1], 10);
      const db = getDb();
      const track = db.prepare(`SELECT id, path, title, artist, ytdl_id FROM tracks WHERE id = ?`).get(trackId) as { id: number; path: string; title: string; artist: string; ytdl_id?: string } | undefined;

      if (track) {
        let fileExists = track.path ? await Deno.stat(track.path).then(s => s.isFile && s.size > 100000).catch(() => false) : false;
        if (!fileExists) {
          const alternate = db.prepare(`
            SELECT id, path, ytdl_id FROM tracks 
            WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE AND id != ?
          `).get(track.artist, track.title, trackId) as { id: number; path: string; ytdl_id?: string } | undefined;
          if (alternate?.path && await Deno.stat(alternate.path).then(s => s.isFile && s.size > 100000).catch(() => false)) {
            track.path = alternate.path;
            if (alternate.ytdl_id) track.ytdl_id = alternate.ytdl_id;
            fileExists = true;
          }
        }

        // 1. FAST PATH: If audio file exists on disk, serve immediately in 1-2ms!
        if (fileExists) {
          const tServe = performance.now() - tStreamStart;
          console.log(`[timing] Stream Track ${trackId} served directly from disk in ${tServe.toFixed(1)}ms (cache HIT, 0ms wait)`);
          return await serveDirectAudioFile(track.path, req);
        }

        // 2. Determine preferred YouTube ID
        let preferredYtdlId = track.ytdl_id;
        if (!preferredYtdlId && track.path) {
          const match = track.path.match(/\[([a-zA-Z0-9_-]{11})\]/);
          if (match) preferredYtdlId = match[1];
        }
        if (!preferredYtdlId) {
          const extRow = db.prepare(`
            SELECT ytdl_id FROM external_catalog 
            WHERE artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE
              AND ytdl_id IS NOT NULL AND length(ytdl_id) >= 11
            LIMIT 1
          `).get(track.artist, track.title) as { ytdl_id?: string } | undefined;
          if (extRow?.ytdl_id) preferredYtdlId = extRow.ytdl_id;
        }

        // 3. Check if file exists under its YouTube ID filename in dynamic/
        if (preferredYtdlId) {
          const altPath = path.join(config.dynamicDir, `${preferredYtdlId}.webm`);
          if (await Deno.stat(altPath).then(s => s.isFile && s.size > 100000).catch(() => false)) {
            track.path = altPath;
            try {
              const conflict = db.prepare(`SELECT id FROM tracks WHERE path = ? AND id != ?`).get(altPath, trackId);
              if (!conflict) {
                db.prepare(`UPDATE tracks SET path = ?, ytdl_id = ?, is_active = 1 WHERE id = ?`).run(altPath, preferredYtdlId, trackId);
              }
            } catch {}
            const tServe = performance.now() - tStreamStart;
            console.log(`[timing] Stream Track ${trackId} served from dynamic cache in ${tServe.toFixed(1)}ms (0ms wait)`);
            return await serveDirectAudioFile(altPath, req);
          }
        }

        // 4. On-demand resolving (Cold search / download)
        console.log(`[stream-proxy] Audio missing on disk for Track ${trackId} ("${track.artist} - ${track.title}"). On-demand resolving (ytdl: ${preferredYtdlId || "searching"})...`);
        const query = `${track.artist} - ${track.title}`.trim();
        activeStreamDownloads.set(trackId, { startedAt: Date.now(), query });
        let fetchRes;
        try {
          fetchRes = await fetchAudioStream(query, { mode: "cache", preferredYtdlId });
        } finally {
          activeStreamDownloads.delete(trackId);
        }
        if (fetchRes.success && fetchRes.filePath) {
          const st = await Deno.stat(fetchRes.filePath).catch(() => null);
          if (!st || !st.isFile || st.size < 100000) {
            console.warn(`[stream-proxy] Downloaded file ${fetchRes.filePath} is too small (${st?.size || 0} bytes)`);
            try { await Deno.remove(fetchRes.filePath); } catch {}
            return new Response("Audio download incomplete", { status: 502 });
          }

          track.path = fetchRes.filePath;
          try {
            const conflict = db.prepare(`SELECT id FROM tracks WHERE path = ? AND id != ?`).get(fetchRes.filePath, trackId) as { id: number } | undefined;
            if (conflict) {
              db.prepare(`UPDATE tracks SET file_size = ?, ytdl_id = COALESCE(?, ytdl_id), is_active = 1, updated_at = ? WHERE id = ?`).run(
                fetchRes.sizeBytes || 0,
                fetchRes.ytdlId || preferredYtdlId || null,
                new Date().toISOString(),
                trackId
              );
            } else {
              db.prepare(`UPDATE tracks SET path = ?, file_size = ?, ytdl_id = COALESCE(?, ytdl_id), is_active = 1, updated_at = ? WHERE id = ?`).run(
                fetchRes.filePath,
                fetchRes.sizeBytes || 0,
                fetchRes.ytdlId || preferredYtdlId || null,
                new Date().toISOString(),
                trackId
              );
            }
          } catch (err) {
            console.warn(`[stream-proxy] Error updating tracks table for ${trackId}:`, err);
          }
          try {
            await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
          } catch {}
          const tServe = performance.now() - tStreamStart;
          console.log(`[timing] Stream Track ${trackId} resolved and served in ${tServe.toFixed(1)}ms`);
          return await serveDirectAudioFile(fetchRes.filePath, req);
        }
        return new Response(JSON.stringify({ error: "Failed to resolve audio stream", track_id: trackId }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
    }

    // A. Intercept /api/radio/start
    if (url.pathname === "/api/radio/start" && req.method === "POST") {
      const tRadioStart = performance.now();
      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers: forwardHeaders,
        body: reqBodyText
      });

      const rawText = await upstreamRes.text();
      let data: any = null;
      try { data = JSON.parse(rawText); } catch {}

      if (upstreamRes.ok && data) {
        const db = getDb();
        let curTrack = data.current;
        let fileOnDisk = false;
        if (curTrack?.path) {
          try { fileOnDisk = Deno.statSync(curTrack.path).isFile; } catch {}
        }
        if (!fileOnDisk && curTrack?.id) {
          const tRow = db.prepare(`SELECT path, ytdl_id FROM tracks WHERE id = ?`).get(curTrack.id) as any;
          if (tRow?.path) {
            try { fileOnDisk = Deno.statSync(tRow.path).isFile; } catch {}
          }
          if (!fileOnDisk && tRow?.ytdl_id) {
            const altPath = path.join(config.dynamicDir, `${tRow.ytdl_id}.webm`);
            try { fileOnDisk = Deno.statSync(altPath).isFile; } catch {}
          }
        }

        // Zero-Latency Radio Start: If Go core picked a track whose audio is missing,
        // switch immediately to an authentic on-disk track (e.g. from favorites) so the user
        // hears music instantly in 0ms instead of waiting 25s for YouTube cold download!
        if (!fileOnDisk) {
          const hotTrack = getHotStartingTrack(db);
          if (hotTrack) {
            console.log(`[radio-start] Track ${curTrack?.id} ("${curTrack?.artist} - ${curTrack?.title}") missing on disk. Switched to hot track ${hotTrack.id} ("${hotTrack.artist} - ${hotTrack.title}") for instant 0ms start!`);
            data.current = {
              id: hotTrack.id,
              artist: hotTrack.artist,
              title: hotTrack.title,
              album: hotTrack.album || "Instant Radio",
              duration: Math.round(hotTrack.duration || 180),
              path: hotTrack.path,
              ready: true,
              stream: `/api/stream/${hotTrack.id}`
            };
          }
        }

        const curId = data.current?.id || 0;
        if (data.session_id && curId) {
          sessionRecentMap.set(data.session_id, [curId]);
        }
        
        // Build balanced queue according to slider
        data.queue = buildBalancedRadioQueue(curId, 6);
        delete data.tracks; // Prevent app.js from hiding queue panel

        if (data.session_id) {
          updateSessionQueue(data.session_id, curId, data.queue);
        }
        radioPoolManager.maintainPool().catch(() => {});

        const tRadioTotal = performance.now() - tRadioStart;
        console.log(`[timing] /api/radio/start completed in ${tRadioTotal.toFixed(1)}ms. Playing Track ${data.current?.id} ("${data.current?.artist} - ${data.current?.title}")`);

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(rawText, {
        status: upstreamRes.status,
        headers: { "Content-Type": upstreamRes.headers.get("content-type") || "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Invalidate favorites cache on favorite or event operations
    if (req.method === "POST" && (url.pathname.includes("/favorites") || url.pathname === "/api/events")) {
      cachedFavoritesResponse = null;
    }

    // Serve cached GET /api/favorites in 0.1ms (eliminates 700ms SQLite scan)
    if (url.pathname === "/api/favorites" && req.method === "GET") {
      const now = Date.now();
      if (cachedFavoritesResponse && now - lastFavoritesCacheTime < 30000) {
        return new Response(cachedFavoritesResponse, {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // B. Intercept /api/events (skip / track_end / undislike) for Anti-Stall Guard & Slider Balance
    if (url.pathname === "/api/events" && req.method === "POST") {
      let evBody: any = {};
      try {
        if (reqBodyText) evBody = JSON.parse(reqBodyText);
      } catch {}

      if (evBody.type === "undislike") {
        const trackId = evBody.track_id;
        const db = getDb();
        if (trackId) {
          db.prepare(`DELETE FROM listening_history WHERE track_id = ? AND action = 'dislike'`).run(trackId);
        }
        return new Response(JSON.stringify({ ok: true, is_rate: true, rating: null, undisliked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers: forwardHeaders,
        body: reqBodyText
      });

      const rawText = await upstreamRes.text();
      let data: any = null;
      try { data = JSON.parse(rawText); } catch {}

      // B1. track_start — rebuild our queue and strip data.tracks so app.js
      //     never sets $("queue").hidden = true in radio mode
      if (upstreamRes.ok && data && evBody.type === "track_start") {
        const startTrackId = evBody.track_id || data.current?.id || 0;
        const sessId = data.session_id || evBody.session_id || "default";

        // In radio mode, always supply our balanced queue and suppress `tracks` array
        const isRadio = (data.mode === "radio" || !data.fixed);
        if (isRadio) {
          data.queue = buildBalancedRadioQueue(startTrackId, 6, [], sessId);
          // Strip any `tracks` field so app.js takes the `else if (data.queue)` branch
          // which shows the queue panel instead of the fixed-playlist panel
          delete data.tracks;
        }

        if (data.session_id) {
          updateSessionQueue(data.session_id, startTrackId, data.queue || []);
        }

        radioPoolManager.maintainPool().catch(() => {});

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (upstreamRes.ok && data && (evBody.type === "skip" || evBody.type === "track_end")) {
        const playedTrackId = evBody.track_id;
        const sessId = data.session_id || evBody.session_id || "default";

        let recents = sessionRecentMap.get(sessId) || [];
        if (playedTrackId && !recents.includes(playedTrackId)) {
          recents.push(playedTrackId);
        }

        const db = getDb();

        const isRadio = (data.mode === "radio" || !data.fixed);

        if (isRadio) {
          console.log(`[radio-engine] Radio mode: dynamically steering next track according to discovery ratio and 12D biases...`);
          const balancedQueue = buildBalancedRadioQueue(playedTrackId, 6, recents.slice(-6), sessId);
          if (balancedQueue.length > 0) {
            const nextCandidate = balancedQueue[0];
            data.next_id = nextCandidate.track_id;
            data.next = {
              id: nextCandidate.track_id,
              artist: nextCandidate.artist,
              title: nextCandidate.title,
              album: nextCandidate.album || "Dynamic Radio",
              duration: nextCandidate.duration || 180,
              ready: true,
              stream: `/api/stream/${nextCandidate.track_id}`
            };
            data.queue = balancedQueue.slice(1);
            data.ended = false;
          }
          // Strip any `tracks` field so app.js never hides the queue panel
          delete data.tracks;
        }

        if (data.next_id && !recents.includes(data.next_id)) {
          recents.push(data.next_id);
        }
        if (recents.length > 30) {
          recents = recents.slice(-30);
        }
        sessionRecentMap.set(sessId, recents);

        const nextId = data.next_id || data.current?.id || 0;
        if (!isRadio) {
          // Build upcoming queue strictly balanced by discoveryRatio
          data.queue = buildBalancedRadioQueue(nextId, 6, recents.slice(-6), sessId);
        }

        // Sync play session in SQLite

        if (data.session_id) {
          updateSessionQueue(data.session_id, nextId, data.queue);
          resetSessionExcludeIfExhausted(data.session_id, nextId, db);
        }

        radioPoolManager.maintainPool().catch(() => {});

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      return new Response(rawText, {
        status: upstreamRes.status,
        headers: { "Content-Type": upstreamRes.headers.get("content-type") || "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // C. Default transparent proxy
    const proxyReq = new Request(upstreamUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: reqBodyText,
      // @ts-ignore: duplex option in fetch
      duplex: "half"
    });

    const upstreamRes = await fetch(proxyReq);
    const contentType = upstreamRes.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      let html = await upstreamRes.text();
      // Inject UI addon script before </body> with cache busting
      if (!html.includes("/addon/ui.js")) {
        html = html.replace("</body>", `<script src="/addon/ui.js?v=2.8.0"></script></body>`);
      }
      const newHeaders = new Headers(upstreamRes.headers);
      newHeaders.delete("content-length");
      newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      newHeaders.set("Pragma", "no-cache");
      return new Response(html, {
        status: upstreamRes.status,
        headers: newHeaders
      });
    }

    if (url.pathname === "/app.js" || url.pathname.endsWith("/app.js")) {
      let js = await upstreamRes.text();
      js += `\n\n// Expose core player functions for addons\nif (typeof window !== "undefined") {\n  try { window.playFixed = playFixed; } catch {}\n  try { window.applyPlayPayload = applyPlayPayload; } catch {}\n  try { window.setView = setView; } catch {}\n  try { window.renderQueue = renderQueue; } catch {}\n  try { window.currentTrack = () => current; } catch {}\n  try { window.setRatingUI = setRatingUI; } catch {}\n  try { window.toggleFavorite = toggleFavorite; } catch {}\n}\n`;
      const newHeaders = new Headers(upstreamRes.headers);
      newHeaders.delete("content-length");
      newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      newHeaders.set("Pragma", "no-cache");
      return new Response(js, {
        status: upstreamRes.status,
        headers: newHeaders
      });
    }

    if (url.pathname === "/api/favorites" && req.method === "GET" && upstreamRes.ok) {
      const favText = await upstreamRes.text();
      cachedFavoritesResponse = favText;
      lastFavoritesCacheTime = Date.now();
      return new Response(favText, {
        status: upstreamRes.status,
        headers: upstreamRes.headers
      });
    }

    return upstreamRes;
  } catch (err) {
    console.error("[proxy-error] Error proxying request:", err);
    return new Response(JSON.stringify({ error: "Upstream player not reachable" }), { status: 502, headers });
  }
});

// Helper for direct audio file streaming with HTTP Range / 206 Partial Content support
async function serveDirectAudioFile(filePath: string, req: Request): Promise<Response> {
  try {
    const stat = await Deno.stat(filePath);
    const total = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".webm" ? "audio/webm" : ext === ".mp4" || ext === ".m4a" ? "audio/mp4" : ext === ".opus" ? "audio/opus" : ext === ".flac" ? "audio/flac" : "audio/mpeg";

    const range = req.headers.get("range");
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        let end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (end >= total) end = total - 1;
        const chunkSize = (end - start) + 1;

        const file = await Deno.open(filePath, { read: true });
        await file.seek(start, Deno.SeekMode.Start);

        const buf = new Uint8Array(chunkSize);
        let bytesRead = 0;
        while (bytesRead < chunkSize) {
          const n = await file.read(buf.subarray(bytesRead));
          if (n === null || n === 0) break;
          bytesRead += n;
        }
        file.close();

        return new Response(buf.subarray(0, bytesRead), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${start + bytesRead - 1}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(bytesRead),
            "Content-Type": mime,
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    const file = await Deno.open(filePath, { read: true });
    return new Response(file.readable, {
      status: 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(total),
        "Content-Type": mime,
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
