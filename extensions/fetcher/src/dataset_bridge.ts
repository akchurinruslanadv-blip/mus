// extensions/fetcher/src/dataset_bridge.ts: 12D Catalog Matching & Radio Blending
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { AcousticFeatures12D, CandidateHit, ExternalCatalogTrack } from "./types.ts";


// Normalized distance in 12D acoustic space
export function compute12DDistance(a: AcousticFeatures12D, b: AcousticFeatures12D): number {
  const dDance = Math.pow(a.danceability - b.danceability, 2);
  const dEnergy = Math.pow(a.energy - b.energy, 2);
  const dValence = Math.pow(a.valence - b.valence, 2);
  const dAcoustic = Math.pow(a.acousticness - b.acousticness, 2);
  const dTempo = Math.pow((a.tempo - b.tempo) / 100, 2);
  const dSpeech = Math.pow((a.speechiness || 0) - (b.speechiness || 0), 2);
  const dLiveness = Math.pow((a.liveness || 0) - (b.liveness || 0), 2);

  // Weighted sum
  const sum = (dDance * 1.5) + (dEnergy * 1.5) + (dValence * 1.2) + (dAcoustic * 1.0) + (dTempo * 1.0) + (dSpeech * 0.5) + (dLiveness * 0.5);
  return Math.sqrt(sum);
}

// Search candidates from `external_catalog`
export function find12DCandidates(
  seed: AcousticFeatures12D,
  limit = 5,
  excludeTitles: Set<string> = new Set(),
  db = getDb()
): CandidateHit[] {
  type RowType = {
    id: number;
    artist: string;
    title: string;
    album: string;
    genre: string;
    duration_sec: number;
    ytdl_id: string;
    features_json: string;
  };

  const countRow = db.prepare(`SELECT count(*) as c FROM external_catalog WHERE is_available = 1`).get() as { c?: number } | undefined;
  const total = countRow?.c || 0;

  let rows: RowType[];
  if (total > 800) {
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, ytdl_id, features_json
      FROM external_catalog
      WHERE is_available = 1 AND id IN (
        SELECT abs(random() % ?) + 1 FROM external_catalog LIMIT 600
      )
    `).all(total) as RowType[];
  } else {
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, ytdl_id, features_json
      FROM external_catalog
      WHERE is_available = 1
    `).all() as RowType[];
  }

  const scored: { track: RowType; features: AcousticFeatures12D; dist: number }[] = [];
  const speechRegex = new RegExp(config.nonMusicKeywords.join("|"), "i");

  for (const row of rows) {
    if (row.duration_sec && (row.duration_sec > config.maxTrackDurationSec || row.duration_sec < config.minTrackDurationSec)) continue;
    const fullText = `${row.genre || ""} ${row.artist} ${row.title}`;
    if (speechRegex.test(fullText)) continue;

    const key = `${row.artist} - ${row.title}`.toLowerCase();
    if (excludeTitles.has(key)) continue;

    let f: AcousticFeatures12D;
    try {
      f = row.features_json ? JSON.parse(row.features_json) : null;
    } catch {
      continue;
    }
    if (!f) continue;
    if (f.speechiness && f.speechiness > config.maxSpeechiness) continue;

    const dist = compute12DDistance(seed, f);
    scored.push({ track: row, features: f, dist });
  }

  scored.sort((a, b) => a.dist - b.dist);

  return scored.slice(0, limit).map(item => {
    const sim = Math.max(0, Math.min(1, 1 - (item.dist / 2.5)));
    return {
      artist: item.track.artist,
      title: item.track.title,
      album: item.track.album,
      genre: item.track.genre,
      ytdlId: item.track.ytdl_id,
      similarity: Math.round(sim * 100) / 100,
      features: item.features,
      reason: `Matching acoustic energy (${Math.round(item.features.energy * 100)}%) and tempo (${Math.round(item.features.tempo)} BPM)`
    };
  });
}

// Cold Start: Get diverse seed tracks across spectrum if library is empty
export function getColdStartSeeds(count = 5, db = getDb()): ExternalCatalogTrack[] {
  // Select top available diverse seeds
  const rows = db.prepare(`
    SELECT id, artist, title, album, duration_sec, ytdl_id, genre, features_json, is_available, added_at
    FROM external_catalog
    WHERE is_available = 1 AND duration_sec BETWEEN ? AND ?
    ORDER BY RANDOM()
    LIMIT ?
  `).all(config.minTrackDurationSec, config.maxTrackDurationSec, count) as ExternalCatalogTrack[];


  return rows.map(r => {
    try {
      r.features = r.features_json ? JSON.parse(r.features_json) : undefined;
    } catch {}
    return r;
  });
}

// Import helper for external 12D tracks
export function insertExternal12DTrack(track: ExternalCatalogTrack, db = getDb()): void {
  const now = new Date().toISOString();
  const featuresJson = track.features ? JSON.stringify(track.features) : (track.features_json || "{}");
  
  db.prepare(`
    INSERT INTO external_catalog (artist, title, album, duration_sec, ytdl_id, genre, features_json, is_available, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(artist, title) DO UPDATE SET
      album = excluded.album,
      ytdl_id = CASE WHEN excluded.ytdl_id != '' THEN excluded.ytdl_id ELSE external_catalog.ytdl_id END,
      features_json = excluded.features_json,
      is_available = excluded.is_available
  `).run(
    track.artist,
    track.title,
    track.album || "",
    track.duration_sec || 180,
    track.ytdl_id || "",
    track.genre || "General",
    featuresJson,
    now
  );
}

// High-speed Batch Transaction Importer for 100k - 1.2M tracks
export function insertExternal12DTracksBatch(
  tracks: ExternalCatalogTrack[],
  db = getDb()
): number {
  let count = 0;
  db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO external_catalog (artist, title, album, duration_sec, ytdl_id, genre, features_json, is_available, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(artist, title) DO UPDATE SET
        album = excluded.album,
        ytdl_id = CASE WHEN excluded.ytdl_id != '' THEN excluded.ytdl_id ELSE external_catalog.ytdl_id END,
        features_json = excluded.features_json,
        is_available = excluded.is_available
    `);

    const now = new Date().toISOString();
    for (const track of tracks) {
      if (!track.artist || !track.title) continue;
      const featuresJson = track.features ? JSON.stringify(track.features) : (track.features_json || "{}");
      stmt.run(
        track.artist,
        track.title,
        track.album || "",
        track.duration_sec || 180,
        track.ytdl_id || "",
        track.genre || "General",
        featuresJson,
        now
      );
      count++;
    }
  })();
  return count;
}

// Predict top catalog tracks matching user taste that can be pre-indexed into 512D
export function findPredictiveCatalogTracks(
  count = 15,
  db = getDb()
): { artist: string; title: string; genre: string; score: number }[] {
  // 1. Compute user acoustic profile from favorites / played tracks
  type FeatRow = { features_json: string };
  let rows = db.prepare(`
    SELECT c.features_json
    FROM favorites f
    JOIN tracks t ON f.track_id = t.id
    JOIN external_catalog c ON LOWER(c.artist) = LOWER(t.artist) AND LOWER(c.title) = LOWER(t.title)
    WHERE c.features_json IS NOT NULL
    LIMIT 50
  `).all() as FeatRow[];

  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT c.features_json
      FROM tracks t
      JOIN external_catalog c ON LOWER(c.artist) = LOWER(t.artist) AND LOWER(c.title) = LOWER(t.title)
      WHERE c.features_json IS NOT NULL
      ORDER BY t.play_count DESC, t.id DESC
      LIMIT 50
    `).all() as FeatRow[];
  }

  let seed: AcousticFeatures12D = {
    danceability: 0.60,
    energy: 0.70,
    key: 0,
    loudness: -7.0,
    mode: 1,
    speechiness: 0.05,
    acousticness: 0.20,
    instrumentalness: 0.05,
    liveness: 0.12,
    valence: 0.55,
    tempo: 120.0
  };

  if (rows.length > 0) {
    let sumDance = 0, sumEnergy = 0, sumValence = 0, sumAcoustic = 0, sumTempo = 0, sumSpeech = 0;
    let validCount = 0;
    for (const r of rows) {
      try {
        const f = JSON.parse(r.features_json) as AcousticFeatures12D;
        if (f && f.energy !== undefined) {
          sumDance += (f.danceability || 0);
          sumEnergy += (f.energy || 0);
          sumValence += (f.valence || 0);
          sumAcoustic += (f.acousticness || 0);
          sumTempo += (f.tempo || 120);
          sumSpeech += (f.speechiness || 0);
          validCount++;
        }
      } catch {}
    }
    if (validCount > 0) {
      seed = {
        danceability: sumDance / validCount,
        energy: sumEnergy / validCount,
        key: 0,
        loudness: -7.0,
        mode: 1,
        speechiness: sumSpeech / validCount,
        acousticness: sumAcoustic / validCount,
        instrumentalness: 0.05,
        liveness: 0.12,
        valence: sumValence / validCount,
        tempo: sumTempo / validCount
      };
    }
  }

  // 2. Fetch candidates from external_catalog that are not yet in library or ingestion queue
  type CandidateRow = {
    id: number;
    artist: string;
    title: string;
    album: string;
    genre: string;
    duration_sec: number;
    features_json: string;
  };

  const pool = db.prepare(`
    SELECT id, artist, title, album, genre, duration_sec, features_json
    FROM external_catalog
    WHERE is_available = 1
      AND duration_sec BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1 FROM tracks tr 
        WHERE LOWER(tr.artist) = LOWER(external_catalog.artist) 
          AND LOWER(tr.title) = LOWER(external_catalog.title)
      )
      AND NOT EXISTS (
        SELECT 1 FROM ingestion_queue iq
        WHERE LOWER(iq.artist) = LOWER(external_catalog.artist)
          AND LOWER(iq.title) = LOWER(external_catalog.title)
          AND iq.status IN ('pending', 'downloading', 'embedding')
      )
    ORDER BY RANDOM()
    LIMIT 800
  `).all(config.minTrackDurationSec, config.maxTrackDurationSec) as CandidateRow[];

  const scored: { artist: string; title: string; genre: string; dist: number }[] = [];
  const speechRegex = new RegExp(config.nonMusicKeywords.join("|"), "i");

  for (const c of pool) {
    if (speechRegex.test(`${c.genre || ""} ${c.artist} ${c.title}`)) continue;
    let f: AcousticFeatures12D;
    try {
      f = c.features_json ? JSON.parse(c.features_json) : null;
    } catch {
      continue;
    }
    if (!f || (f.speechiness && f.speechiness > config.maxSpeechiness)) continue;

    const dist = compute12DDistance(seed, f);
    scored.push({
      artist: c.artist,
      title: c.title,
      genre: c.genre || "General",
      dist
    });
  }

  scored.sort((a, b) => a.dist - b.dist);

  return scored.slice(0, count).map(s => ({
    artist: s.artist,
    title: s.title,
    genre: s.genre,
    score: Math.round(Math.max(0, Math.min(1, 1 - (s.dist / 2.5))) * 100) / 100
  }));
}
