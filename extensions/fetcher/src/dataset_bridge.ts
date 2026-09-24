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
