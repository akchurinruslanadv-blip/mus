// extensions/fetcher/src/db.ts: Database Access & Schema Migrations
import { Database } from "@db/sqlite";
import { config } from "./config.ts";
import { ExternalCatalogTrack, AcousticFeatures12D } from "./types.ts";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    try {
      _db.exec("PRAGMA journal_mode = WAL;");
      _db.exec("PRAGMA busy_timeout = 5000;");
    } catch {}
    initSchema(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function initSchema(db: Database): void {
  // 1. External 12D Catalog Table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS external_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      album TEXT,
      duration_sec REAL DEFAULT 180,
      ytdl_id TEXT,
      genre TEXT,
      features_json TEXT,
      source_url TEXT,
      play_count INTEGER NOT NULL DEFAULT 0,
      skip_count INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT,
      is_available INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL,
      UNIQUE(artist, title)
    )
  `).run();

  // 2. Pinned Tracks Table (💾 Сохранить навсегда)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pinned_tracks (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      pinned_at TEXT NOT NULL
    )
  `).run();

  // 3. Ingestion Queue Table (Фоновый конвейер импорта плейлистов)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS ingestion_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      add_to_favorites INTEGER NOT NULL DEFAULT 0,
      pin_forever INTEGER NOT NULL DEFAULT 0,
      auto_embed_512 INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      track_id INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `).run();

  // 4. Radio Settings per Session / Device (P1: Persistent Settings)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS radio_settings (
      session_id TEXT PRIMARY KEY,
      discovery_ratio REAL NOT NULL DEFAULT 0.5,
      updated_at TEXT NOT NULL
    )
  `).run();

  // Indices for fast search

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ext_cat_lookup 
    ON external_catalog(artist, title)
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ext_cat_available 
    ON external_catalog(is_available)
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ingest_status 
    ON ingestion_queue(status)
  `).run();

  try {
    const hasHistory = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='listening_history'`).get();
    if (hasHistory) {
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_listening_history_ts 
        ON listening_history(ts DESC)
      `).run();

      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_listening_history_track 
        ON listening_history(track_id, ts DESC)
      `).run();
    }
  } catch {}
}

// Track Pinning (💾 Сохранить навсегда)
export function isTrackPinned(trackId: number, db = getDb()): boolean {
  const row = db.prepare(`SELECT 1 FROM pinned_tracks WHERE track_id = ?`).get(trackId);
  return !!row;
}

export function pinTrack(trackId: number, db = getDb()): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pinned_tracks (track_id, pinned_at) 
    VALUES (?, ?)
    ON CONFLICT(track_id) DO NOTHING
  `).run(trackId, now);
}

export function unpinTrack(trackId: number, db = getDb()): void {
  db.prepare(`DELETE FROM pinned_tracks WHERE track_id = ?`).run(trackId);
}

export function getAllPinnedTrackIds(db = getDb()): Set<number> {
  const rows = db.prepare(`SELECT track_id FROM pinned_tracks`).all() as { track_id: number }[];
  return new Set(rows.map(r => r.track_id));
}

// Active Play Sessions & Queue
export interface SessionState {
  id: string;
  mode: string;
  currentId: number;
  queue: { track_id: number; artist: string; title: string; path: string }[];
  updatedAt: string;
}

export function getActiveSession(db = getDb()): SessionState | null {
  const row = db.prepare(`
    SELECT id, mode, current_id, queue_json, updated_at 
    FROM play_sessions 
    ORDER BY updated_at DESC 
    LIMIT 1
  `).get() as { id: string; mode: string; current_id: number; queue_json: string; updated_at: string } | undefined;

  if (!row) return null;

  let queue: { track_id: number; artist: string; title: string; path: string }[] = [];
  try {
    const parsed = row.queue_json ? JSON.parse(row.queue_json) : [];
    if (Array.isArray(parsed)) {
      queue = parsed;
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.items)) queue = parsed.items;
      else if (Array.isArray(parsed.queue)) queue = parsed.queue;
    }
  } catch {
    queue = [];
  }

  return {
    id: row.id,
    mode: row.mode,
    currentId: row.current_id,
    queue: Array.isArray(queue) ? queue : [],
    updatedAt: row.updated_at
  };
}

// Register or Update Track in DB
export function upsertTrack(meta: {
  path: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  fileSize?: number;
}, db = getDb()): number {
  const now = new Date().toISOString();

  // First check if a track with this artist and title already exists
  const existing = db.prepare(`
    SELECT id FROM tracks 
    WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(meta.artist, meta.title) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE tracks 
      SET path = ?, duration = COALESCE(?, duration), file_size = COALESCE(?, file_size), is_active = 1, updated_at = ?
      WHERE id = ?
    `).run(meta.path, meta.duration || 180, meta.fileSize || 0, now, existing.id);
    return existing.id;
  }

  db.prepare(`
    INSERT INTO tracks (path, title, artist, album, duration, file_size, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      duration = excluded.duration,
      file_size = excluded.file_size,
      updated_at = excluded.updated_at
  `).run(
    meta.path,
    meta.title,
    meta.artist,
    meta.album || "Web Stream",
    meta.duration || 180,
    meta.fileSize || 0,
    now,
    now
  );

  const row = db.prepare(`SELECT id FROM tracks WHERE path = ?`).get(meta.path) as { id: number };
  return row.id;
}

export function markTrackUnavailable(ytdlIdOrTitle: string, db = getDb()): void {
  db.prepare(`
    UPDATE external_catalog 
    SET is_available = 0 
    WHERE ytdl_id = ? OR (artist || ' - ' || title) LIKE ?
  `).run(ytdlIdOrTitle, `%${ytdlIdOrTitle}%`);
}

// Ingestion Queue Helpers
export function addIngestionTasks(
  tasks: { artist: string; title: string; addToFavorites: boolean; pinForever: boolean; autoEmbed512: boolean }[],
  db = getDb()
): number {
  const now = new Date().toISOString();
  let added = 0;

  db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO ingestion_queue (artist, title, add_to_favorites, pin_forever, auto_embed_512, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `);

    for (const t of tasks) {
      if (!t.artist.trim() || !t.title.trim()) continue;
      stmt.run(
        t.artist.trim(),
        t.title.trim(),
        t.addToFavorites ? 1 : 0,
        t.pinForever ? 1 : 0,
        t.autoEmbed512 ? 1 : 0,
        now
      );
      added++;
    }
  })();

  return added;
}

export function getNextPendingIngestionTask(db = getDb()): {
  id: number;
  artist: string;
  title: string;
  addToFavorites: boolean;
  pinForever: boolean;
  autoEmbed512: boolean;
  status: string;
  createdAt: string;
} | null {
  const row = db.prepare(`
    SELECT id, artist, title, add_to_favorites, pin_forever, auto_embed_512, status, created_at
    FROM ingestion_queue
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `).get() as {
    id: number;
    artist: string;
    title: string;
    add_to_favorites: number;
    pin_forever: number;
    auto_embed_512: number;
    status: string;
    created_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    artist: row.artist,
    title: row.title,
    addToFavorites: row.add_to_favorites === 1,
    pinForever: row.pin_forever === 1,
    autoEmbed512: row.auto_embed_512 === 1,
    status: row.status,
    createdAt: row.created_at
  };
}

export function updateIngestionTaskStatus(
  id: number,
  status: string,
  error?: string,
  trackId?: number,
  db = getDb()
): void {
  const completedAt = (status === "ready" || status === "failed" || status === "skipped") ? new Date().toISOString() : null;
  db.prepare(`
    UPDATE ingestion_queue
    SET status = ?, error = ?, track_id = COALESCE(?, track_id), completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `).run(status, error || null, trackId || null, completedAt, id);
}

export function getIngestionStatusSummary(db = getDb()): {
  total: number;
  pending: number;
  processing: number;
  ready: number;
  failed: number;
} {
  const row = db.prepare(`
    SELECT 
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status IN ('downloading', 'embedding') THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM ingestion_queue
  `).get() as { total: number; pending: number; processing: number; ready: number; failed: number };

  return {
    total: row.total || 0,
    pending: row.pending || 0,
    processing: row.processing || 0,
    ready: row.ready || 0,
    failed: row.failed || 0
  };
}

export function clearIngestionQueue(db = getDb()): void {
  db.prepare(`DELETE FROM ingestion_queue`).run();
}

// Favorites Helpers
export function addToFavorites(trackId: number, db = getDb()): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO favorites (track_id, added_at, position)
    VALUES (?, ?, COALESCE((SELECT MAX(position)+1 FROM favorites), 0))
    ON CONFLICT(track_id) DO NOTHING
  `).run(trackId, now);
}

export function removeFromFavorites(trackId: number, db = getDb()): void {
  db.prepare(`DELETE FROM favorites WHERE track_id = ?`).run(trackId);
}

export function isFavorite(trackId: number, db = getDb()): boolean {
  const row = db.prepare(`SELECT 1 FROM favorites WHERE track_id = ?`).get(trackId);
  return !!row;
}

// Embedding & Track Lookup Helpers
export function has512Embedding(trackId: number, db = getDb()): boolean {
  const row = db.prepare(`
    SELECT 1 FROM features 
    WHERE track_id = ? AND status = 'ready' AND embedding IS NOT NULL
  `).get(trackId);
  return !!row;
}

export function getNextTrackMissing512Embedding(db = getDb()): { id: number; path: string; artist: string; title: string } | null {
  const row = db.prepare(`
    SELECT t.id, t.path, t.artist, t.title
    FROM tracks t
    LEFT JOIN features f ON f.track_id = t.id
    WHERE (f.embedding IS NULL OR f.status != 'ready') AND t.is_active = 1
    ORDER BY t.id ASC
    LIMIT 1
  `).get() as { id: number; path: string; artist: string; title: string } | undefined;

  return row || null;
}

export function findTrackByArtistTitle(
  artist: string,
  title: string,
  db = getDb()
): { id: number; path: string; hasEmbedding: boolean } | null {
  const row = db.prepare(`
    SELECT t.id, t.path, CASE WHEN f.embedding IS NOT NULL THEN 1 ELSE 0 END AS has_embedding
    FROM tracks t
    LEFT JOIN features f ON f.track_id = t.id
    WHERE LOWER(t.artist) = LOWER(?) AND LOWER(t.title) = LOWER(?)
    LIMIT 1
  `).get(artist, title) as { id: number; path: string; has_embedding: number } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    hasEmbedding: row.has_embedding === 1
  };
}

export function recordTrackPlay(artist: string, title: string, db = getDb()): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE external_catalog 
    SET play_count = play_count + 1, last_played_at = ?
    WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?)
  `).run(now, artist, title);
}

export function recordTrackSkip(artist: string, title: string, db = getDb()): void {
  db.prepare(`
    UPDATE external_catalog 
    SET skip_count = skip_count + 1
    WHERE LOWER(artist) = LOWER(?) AND LOWER(title) = LOWER(?)
  `).run(artist, title);
}

export interface ReadyTrackCandidate {
  track_id: number;
  artist: string;
  title: string;
  album: string;
  path: string;
  duration: number;
  score: number;
  explanation: string;
  explore: boolean;
  new_boost: boolean;
  cluster_id: number;
}

export function get512DCandidates(
  excludeIds: number[],
  limit = 5,
  db = getDb(),
  excludeFavorites = false
): ReadyTrackCandidate[] {
  const placeholders = excludeIds.length > 0 ? excludeIds.map(() => "?").join(",") : "0";
  const favFilter = excludeFavorites ? "AND t.id NOT IN (SELECT track_id FROM favorites)" : "";
  const rows = db.prepare(`
    SELECT t.id, t.artist, t.title, t.album, t.path, t.duration
    FROM tracks t
    JOIN features f ON f.track_id = t.id AND f.status = 'ready' AND f.embedding IS NOT NULL
    WHERE t.id NOT IN (${placeholders}) ${favFilter}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...excludeIds, limit) as {

    id: number;
    artist: string;
    title: string;
    album: string;
    path: string;
    duration: number;
  }[];

  return rows.map((r, i) => ({
    track_id: r.id,
    artist: r.artist,
    title: r.title,
    album: r.album || "Library",
    path: r.path,
    duration: Math.round(r.duration || 180),
    score: 0.75 - i * 0.05,
    explanation: "512D acoustic discovery",
    explore: true,
    new_boost: false,
    cluster_id: -1
  }));
}

export function getFavoriteCandidates(
  excludeIds: number[],
  limit = 5,
  db = getDb()
): ReadyTrackCandidate[] {
  const placeholders = excludeIds.length > 0 ? excludeIds.map(() => "?").join(",") : "0";
  const rows = db.prepare(`
    SELECT t.id, t.artist, t.title, t.album, t.path, t.duration
    FROM tracks t
    JOIN favorites fav ON fav.track_id = t.id
    WHERE t.id NOT IN (${placeholders}) AND t.is_active = 1
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...excludeIds, limit) as {
    id: number;
    artist: string;
    title: string;
    album: string;
    path: string;
    duration: number;
  }[];

  return rows.map((r, i) => ({
    track_id: r.id,
    artist: r.artist,
    title: r.title,
    album: r.album || "Favorites",
    path: r.path,
    duration: Math.round(r.duration || 180),
    score: 0.95 - i * 0.05,
    explanation: "Любимый трек (Избранное)",
    explore: false,
    new_boost: false,
    cluster_id: -1
  }));
}


export function updateSessionQueue(
  sessionId: string,
  currentId: number,
  queue: any[],
  db = getDb()
): void {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE play_sessions 
      SET current_id = ?, queue_json = ?, updated_at = ?
      WHERE id = ?
    `).run(currentId, JSON.stringify(queue), now, sessionId);
  } catch (e) {
    console.warn("[db] updateSessionQueue warning (sqlite busy):", e);
  }
}

export function resetSessionExcludeIfExhausted(
  sessionId: string,
  currentId: number,
  db = getDb()
): void {
  try {
    const totalTracks = (db.prepare(`SELECT count(*) as c FROM tracks`).get() as { c: number }).c;
    const sessRow = db.prepare(`SELECT exclude_json FROM play_sessions WHERE id = ?`).get(sessionId) as { exclude_json?: string } | undefined;
    if (!sessRow?.exclude_json) return;

    const excluded = JSON.parse(sessRow.exclude_json);
    if (Array.isArray(excluded) && excluded.length >= totalTracks) {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE play_sessions 
        SET exclude_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify([currentId]), now, sessionId);
    }
  } catch (e) {
    console.warn("[db] resetSessionExclude warning:", e);
  }
}

// P1: Radio Discovery Ratio persistence per session/device
export function getDiscoveryRatio(sessionId = "default", db = getDb()): number {
  try {
    const row = db.prepare(`SELECT discovery_ratio FROM radio_settings WHERE session_id = ?`).get(sessionId) as { discovery_ratio: number } | undefined;
    if (row && typeof row.discovery_ratio === "number") {
      return row.discovery_ratio;
    }
    if (sessionId !== "default") {
      const defRow = db.prepare(`SELECT discovery_ratio FROM radio_settings WHERE session_id = 'default'`).get() as { discovery_ratio: number } | undefined;
      if (defRow && typeof defRow.discovery_ratio === "number") {
        return defRow.discovery_ratio;
      }
    }
  } catch {}
  return 0.5;
}

export function setDiscoveryRatio(sessionId = "default", ratio: number, db = getDb()): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO radio_settings (session_id, discovery_ratio, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        discovery_ratio = excluded.discovery_ratio,
        updated_at = excluded.updated_at
    `).run(sessionId, clamped, now);
  } catch (e) {
    console.warn("[db] setDiscoveryRatio error:", e);
  }
  return clamped;
}

