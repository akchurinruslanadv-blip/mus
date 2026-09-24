// extensions/fetcher/src/server.ts: Sidecar HTTP API Server
import * as path from "@std/path";
import { config } from "./config.ts";
import { 
  getDb, 
  addIngestionTasks, 
  clearIngestionQueue, 
  get512DCandidates, 
  getFavoriteCandidates,
  isFavorite,
  getActiveSession,
  updateSessionQueue, 
  resetSessionExcludeIfExhausted,
  getDiscoveryRatio,
  setDiscoveryRatio
} from "./db.ts";
import { fetchAudioStream, updateYtDlp } from "./fetcher.ts";
import { getCacheStats, enforceLruCache, cleanCacheNow } from "./lru.ts";
import { startQueueWatcher } from "./queue_watcher.ts";
import { resolveTrackAudio, pinTrackForever, unpinTrackFromStorage } from "./stream_proxy.ts";
import { find12DCandidates, getColdStartSeeds } from "./dataset_bridge.ts";
import { ingestionWorker } from "./ingestion_worker.ts";
import { radioPoolManager } from "./radio_pool.ts";

// Start background workers
startQueueWatcher();
ingestionWorker.start();
radioPoolManager.start();

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

// Builder for dynamic balanced queue honoring user's discoveryRatio (P1: Session-aware & SQLite-backed)
function buildBalancedRadioQueue(currentTrackId: number, count = 6, excludeRecentIds: number[] = [], sessionId = "default"): any[] {
  const db = getDb();
  const ratio = getDiscoveryRatio(sessionId, db);
  const targetDiscovery = Math.round(count * ratio);
  const targetFavorites = count - targetDiscovery;

  const queue: any[] = [];
  const selectedIds = new Set<number>([currentTrackId, ...excludeRecentIds]);


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

  // 2. Gather Discovery candidates (from ready radioPoolManager or fresh catalog)
  let discCandidates: any[] = [];
  if (targetDiscovery > 0) {
    const readyPool = radioPoolManager.getPool().filter(c => 
      c.isReady && 
      c.trackId && 
      !selectedIds.has(c.trackId) &&
      !isFavorite(c.trackId, db)
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
        explanation: "512D acoustic discovery",
        explore: true,
        new_boost: true,
        cluster_id: -1
      });
      selectedIds.add(pc.trackId!);
    }

    // If pool didn't have enough ready discovery tracks, supplement with strictly non-favorite library tracks
    if (discCandidates.length < targetDiscovery) {
      const needed = targetDiscovery - discCandidates.length;
      const extraDisc = get512DCandidates(Array.from(selectedIds), needed, db, true);
      discCandidates.push(...extraDisc);
    }

  }

  // 3. Interleave or combine according to ratio
  let favIdx = 0;
  let discIdx = 0;
  while (queue.length < count && (favIdx < favCandidates.length || discIdx < discCandidates.length)) {
    if (ratio >= 0.7) {
      // Discovery heavy: take disc first
      if (discIdx < discCandidates.length) queue.push(discCandidates[discIdx++]);
      else if (favIdx < favCandidates.length) queue.push(favCandidates[favIdx++]);
    } else if (ratio <= 0.3) {
      // Favorite heavy: take fav first
      if (favIdx < favCandidates.length) queue.push(favCandidates[favIdx++]);
      else if (discIdx < discCandidates.length) queue.push(discCandidates[discIdx++]);
    } else {
      // Balanced: alternate
      if (discIdx < discCandidates.length && (queue.length % 2 === 1 || favIdx >= favCandidates.length)) {
        queue.push(discCandidates[discIdx++]);
      } else if (favIdx < favCandidates.length) {
        queue.push(favCandidates[favIdx++]);
      } else if (discIdx < discCandidates.length) {
        queue.push(discCandidates[discIdx++]);
      }
    }
  }

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

  // 5.5 Radio Listening History (Unlimited & Lightweight)
  if ((url.pathname === "/api/v1/radio/history" || url.pathname === "/api/history") && req.method === "GET") {
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam) : -1; // -1 = Unlimited in SQLite
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const query = (url.searchParams.get("q") || "").trim();
    const db = getDb();
    try {
      let sql = `
        SELECT 
          t.id,
          t.artist,
          t.title,
          t.duration,
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
      `;
      const params: any[] = [];
      if (query) {
        sql += ` WHERE (t.artist LIKE ? OR t.title LIKE ?)`;
        params.push(`%${query}%`, `%${query}%`);
      }
      sql += `
        ORDER BY h.max_ts DESC
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);

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

        for (const r of rows) {
          origins[r.id] = r;
          const k = `${r.artist || ""}|||${r.title || ""}`.toLowerCase();
          originsByQuery[k] = r;
        }
      }

      if (queries.length > 0) {
        for (const q of queries) {
          const k = `${q.artist || ""}|||${q.title || ""}`.toLowerCase();
          if (originsByQuery[k]) continue;

          let row: any = null;
          if (q.artist && q.title) {
            row = db.prepare(`
              SELECT 
                t.id, t.artist, t.title,
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
                t.id, t.artist, t.title,
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
            origins[row.id] = row;
            originsByQuery[k] = row;
          }
        }
      }

      return new Response(JSON.stringify({ origins, originsByQuery }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ origins: {}, originsByQuery: {}, error: String(e) }), { headers });
    }
  }

  // 5.7 Radio Settings (Discovery Balance) - P1: Persistent in SQLite per session/device
  if (url.pathname === "/api/v1/radio/settings" && req.method === "POST") {
    try {
      const body = await req.json();
      const db = getDb();
      const activeSession = getActiveSession(db);
      const sessionId = body.sessionId || body.session_id || (activeSession ? activeSession.id : "default");

      let ratio = 0.5;
      if (typeof body.discoveryRatio === "number") {
        ratio = setDiscoveryRatio(sessionId, body.discoveryRatio, db);
        if (sessionId !== "default") {
          setDiscoveryRatio("default", body.discoveryRatio, db);
        }
      } else {
        ratio = getDiscoveryRatio(sessionId, db);
      }

      let updatedQueue: any[] = [];
      if (activeSession && activeSession.currentId) {
        updatedQueue = buildBalancedRadioQueue(activeSession.currentId, 6, [], sessionId);
        updateSessionQueue(activeSession.id, activeSession.currentId, updatedQueue);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        settings: { discoveryRatio: ratio, sessionId }, 
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
    const ratio = getDiscoveryRatio(sessionId, db);
    return new Response(JSON.stringify({ settings: { discoveryRatio: ratio, sessionId } }), { headers });
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
      const trackId = parseInt(streamMatch[1], 10);
      const db = getDb();
      const track = db.prepare(`SELECT id, path, title, artist FROM tracks WHERE id = ?`).get(trackId) as { id: number; path: string; title: string; artist: string } | undefined;

      if (track) {
        let fileExists = track.path ? await Deno.stat(track.path).then(s => s.isFile).catch(() => false) : false;

        // Check if file exists under its YouTube ID filename in dynamic/
        if (!fileExists && track.path) {
          const ytdlMatch = track.path.match(/\[([a-zA-Z0-9_-]{11})\]/);
          if (ytdlMatch) {
            const altPath = path.join(config.dynamicDir, `${ytdlMatch[1]}.webm`);
            if (await Deno.stat(altPath).then(s => s.isFile).catch(() => false)) {
              track.path = altPath;
              db.prepare(`UPDATE tracks SET path = ? WHERE id = ?`).run(altPath, trackId);
              fileExists = true;
            }
          }
        }

        // If audio file is missing on disk, resolve it on-demand!
        if (!fileExists) {
          console.log(`[stream-proxy] Audio missing on disk for Track ${trackId} ("${track.artist} - ${track.title}"). On-demand resolving...`);
          const query = `${track.artist} - ${track.title}`.trim();
          const fetchRes = await fetchAudioStream(query, { mode: "cache" });
          if (fetchRes.success && fetchRes.filePath) {
            track.path = fetchRes.filePath;
            db.prepare(`UPDATE tracks SET path = ?, file_size = ?, is_active = 1, updated_at = ? WHERE id = ?`).run(
              fetchRes.filePath,
              fetchRes.sizeBytes || 0,
              new Date().toISOString(),
              trackId
            );
            fileExists = true;
            try {
              await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
            } catch {}
          }
        }

        // If file exists, try proxying to Go core first
        if (fileExists) {
          try {
            const upstreamRes = await fetch(new Request(upstreamUrl.toString(), {
              method: req.method,
              headers: forwardHeaders
            }));

            if (upstreamRes.ok || upstreamRes.status === 206) {
              return upstreamRes;
            }
          } catch {}

          // Fallback: Direct audio stream with Range / 206 support
          return await serveDirectAudioFile(track.path, req);
        }
      }
    }

    // A. Intercept /api/radio/start
    if (url.pathname === "/api/radio/start" && req.method === "POST") {
      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers: forwardHeaders,
        body: reqBodyText
      });

      const rawText = await upstreamRes.text();
      let data: any = null;
      try { data = JSON.parse(rawText); } catch {}

      if (upstreamRes.ok && data) {
        const curId = data.current?.id || 0;
        if (data.session_id && curId) {
          sessionRecentMap.set(data.session_id, [curId]);
        }
        
        // Build balanced queue according to slider
        data.queue = buildBalancedRadioQueue(curId, 6);

        if (data.session_id) {
          updateSessionQueue(data.session_id, curId, data.queue);
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

    // B. Intercept /api/events (skip / track_end) for Anti-Stall Guard & Slider Balance
    if (url.pathname === "/api/events" && req.method === "POST") {
      let evBody: any = {};
      try {
        if (reqBodyText) evBody = JSON.parse(reqBodyText);
      } catch {}

      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: "POST",
        headers: forwardHeaders,
        body: reqBodyText
      });

      const rawText = await upstreamRes.text();
      let data: any = null;
      try { data = JSON.parse(rawText); } catch {}

      if (upstreamRes.ok && data && (evBody.type === "skip" || evBody.type === "track_end")) {
        const playedTrackId = evBody.track_id;
        const sessId = data.session_id || evBody.session_id || "default";

        let recents = sessionRecentMap.get(sessId) || [];
        if (playedTrackId && !recents.includes(playedTrackId)) {
          recents.push(playedTrackId);
        }

        const db = getDb();
        const ratio = getDiscoveryRatio(sessId, db);
        const recentWindow = recents.slice(-25);
        const isDirectStall = (data.next_id === playedTrackId) || (!data.next && !data.ended) || (data.next_id === 0 && !data.ended);
        const isRecentRepeat = data.next_id ? recentWindow.includes(data.next_id) : false;
        const isUpstreamFallback = (data.next_id === 1 && recents.includes(1));

        // Ratio adherence:
        // If ratio >= 0.7, next track should NOT be an existing favorite!
        // If ratio <= 0.3, next track MUST be an existing favorite!

        const nextIsFav = data.next_id ? isFavorite(data.next_id, db) : false;
        const ratioMismatch = (ratio >= 0.7 && nextIsFav) || (ratio <= 0.3 && !nextIsFav);

        const shouldSubstitute = (data.mode === "radio" || !data.fixed) && (isDirectStall || isRecentRepeat || isUpstreamFallback || ratioMismatch);

        if (shouldSubstitute || (data.ended && data.mode === "radio")) {
          console.log(`[radio-engine] Selecting next track (next=${data.next_id}, played=${playedTrackId}, ratio=${ratio})...`);
          let nextCandidate: any = null;

          // 1. Try taking from current queue if valid
          if (Array.isArray(data.queue) && data.queue.length > 0) {
            const validIdx = data.queue.findIndex((q: any) => q.track_id && q.track_id !== playedTrackId && !recentWindow.includes(q.track_id));
            if (validIdx !== -1) {
              nextCandidate = data.queue.splice(validIdx, 1)[0];
            }
          }

          // 2. Fallback based on ratio
          if (!nextCandidate) {
            if (ratio <= 0.3) {
              const favs = getFavoriteCandidates([playedTrackId, ...recents], 1, db);
              if (favs.length > 0) nextCandidate = favs[0];
            } else if (ratio >= 0.7) {
              const poolReady = radioPoolManager.getPool().find(c => 
                c.isReady && 
                c.trackId && 
                c.trackId !== playedTrackId && 
                !recentWindow.includes(c.trackId) &&
                !isFavorite(c.trackId, db)
              );
              if (poolReady && poolReady.trackId) {
                nextCandidate = {
                  track_id: poolReady.trackId,
                  artist: poolReady.artist,
                  title: poolReady.title,
                  album: "Radio Discovery",
                  duration: 180
                };
              }
            }
          }

          // 3. Fallback to 512D library candidates (strictly non-favorites if ratio >= 0.7)
          if (!nextCandidate) {
            const smallExclude = Array.from(new Set([playedTrackId, ...recents.slice(-6)].filter(Boolean)));
            const candidates = get512DCandidates(smallExclude, 1, db, ratio >= 0.7);
            if (candidates.length > 0) nextCandidate = candidates[0];
          }


          if (nextCandidate) {
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
            data.ended = false;
          }
        }

        if (data.next_id && !recents.includes(data.next_id)) {
          recents.push(data.next_id);
        }
        if (recents.length > 30) {
          recents = recents.slice(-30);
        }
        sessionRecentMap.set(sessId, recents);

        // Build upcoming queue strictly balanced by discoveryRatio
        const nextId = data.next_id || data.current?.id || 0;
        data.queue = buildBalancedRadioQueue(nextId, 6, recents.slice(-6), sessId);

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
        html = html.replace("</body>", `<script src="/addon/ui.js?v=2.6.0"></script></body>`);
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
