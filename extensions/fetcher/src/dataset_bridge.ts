// extensions/fetcher/src/dataset_bridge.ts: 12D Catalog Matching & Radio Blending
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { AcousticFeatures12D, CandidateHit, ExternalCatalogTrack, AcousticBiases } from "./types.ts";

// Apply user interactive slider biases to shift the recommendation vector
export function applyAcousticBiases(seed: AcousticFeatures12D, biases?: AcousticBiases): AcousticFeatures12D {
  if (!biases) return seed;
  return {
    ...seed,
    energy: Math.max(0, Math.min(1, seed.energy + (biases.energy || 0))),
    valence: Math.max(0, Math.min(1, seed.valence + (biases.valence || 0))),
    acousticness: Math.max(0, Math.min(1, seed.acousticness + (biases.acousticness || 0))),
    tempo: Math.max(40, Math.min(240, seed.tempo * (1 + (biases.tempo || 0))))
  };
}

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
  db = getDb(),
  biases?: AcousticBiases
): CandidateHit[] {
  const effectiveSeed = applyAcousticBiases(seed, biases);
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

  const hasActiveBiases = biases && (
    (biases.energy && Math.abs(biases.energy) > 0.04) ||
    (biases.valence && Math.abs(biases.valence) > 0.04) ||
    (biases.acousticness && Math.abs(biases.acousticness) > 0.04) ||
    (biases.tempo && Math.abs(biases.tempo) > 0.04)
  );

  const conditions = ["is_available = 1"];
  if (biases) {
    if (biases.energy && biases.energy > 0.05) {
      const minEnergy = Math.min(0.85, Math.max(0.55, effectiveSeed.energy - 0.15));
      conditions.push(`json_extract(features_json, '$.energy') >= ${minEnergy.toFixed(2)}`);
    } else if (biases.energy && biases.energy < -0.05) {
      const maxEnergy = Math.max(0.20, Math.min(0.50, effectiveSeed.energy + 0.15));
      conditions.push(`json_extract(features_json, '$.energy') <= ${maxEnergy.toFixed(2)}`);
    }

    if (biases.acousticness && biases.acousticness > 0.05) {
      const minAcoustic = Math.min(0.80, Math.max(0.40, effectiveSeed.acousticness - 0.15));
      conditions.push(`json_extract(features_json, '$.acousticness') >= ${minAcoustic.toFixed(2)}`);
    } else if (biases.acousticness && biases.acousticness < -0.05) {
      const maxAcoustic = Math.max(0.10, Math.min(0.25, effectiveSeed.acousticness + 0.10));
      conditions.push(`json_extract(features_json, '$.acousticness') <= ${maxAcoustic.toFixed(2)}`);
    }

    if (biases.valence && biases.valence > 0.05) {
      const minValence = Math.min(0.80, Math.max(0.55, effectiveSeed.valence - 0.15));
      conditions.push(`json_extract(features_json, '$.valence') >= ${minValence.toFixed(2)}`);
    } else if (biases.valence && biases.valence < -0.05) {
      const maxValence = Math.max(0.20, Math.min(0.42, effectiveSeed.valence + 0.15));
      conditions.push(`json_extract(features_json, '$.valence') <= ${maxValence.toFixed(2)}`);
    }

    if (biases.tempo && biases.tempo > 0.05) {
      const minTempo = Math.min(160, Math.max(120, effectiveSeed.tempo - 15));
      conditions.push(`json_extract(features_json, '$.tempo') >= ${Math.round(minTempo)}`);
    } else if (biases.tempo && biases.tempo < -0.05) {
      const maxTempo = Math.max(70, Math.min(105, effectiveSeed.tempo + 15));
      conditions.push(`json_extract(features_json, '$.tempo') <= ${Math.round(maxTempo)}`);
    }
  }

  let rows: RowType[] = [];
  if (total > 1000) {
    // Pick a random starting point across the 3.27M catalog to ensure infinite variety on every slider adjustment
    const randomStartId = Math.floor(Math.random() * Math.max(1, total - 12000));
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, ytdl_id, features_json
      FROM external_catalog
      WHERE id >= ? AND ${conditions.join(" AND ")}
      LIMIT 400
    `).all(randomStartId) as RowType[];

    // If near the tail of the table or very strict condition, wrap around to head
    if (rows.length < 60) {
      const wrapRows = db.prepare(`
        SELECT id, artist, title, album, genre, duration_sec, ytdl_id, features_json
        FROM external_catalog
        WHERE ${conditions.join(" AND ")}
        LIMIT 400
      `).all() as RowType[];
      rows.push(...wrapRows);
    }
  } else {
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, ytdl_id, features_json
      FROM external_catalog
      WHERE ${conditions.join(" AND ")}
      LIMIT 400
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

    const dist = compute12DDistance(effectiveSeed, f);
    scored.push({ track: row, features: f, dist });
  }

  scored.sort((a, b) => a.dist - b.dist);

  return scored.slice(0, limit).map(item => {
    const sim = Math.max(0, Math.min(1, 1 - (item.dist / 2.5)));
    const energyPct = Math.round(item.features.energy * 100);
    const tempoVal = Math.round(item.features.tempo);
    const acousticPct = Math.round(item.features.acousticness * 100);
    const valencePct = Math.round(item.features.valence * 100);

    let reason = `12D сходство (Драйв ${energyPct}%, ${tempoVal} BPM)`;
    if (biases) {
      const parts: string[] = [];
      if (biases.energy && biases.energy > 0.05) parts.push(`⚡ Драйв ${energyPct}%`);
      else if (biases.energy && biases.energy < -0.05) parts.push(`🌙 Чилл ${energyPct}%`);

      if (biases.acousticness && biases.acousticness > 0.05) parts.push(`🎸 Акустика ${acousticPct}%`);
      else if (biases.acousticness && biases.acousticness < -0.05) parts.push(`🎹 Электроника`);

      if (biases.valence && biases.valence > 0.05) parts.push(`☀️ Позитив ${valencePct}%`);
      else if (biases.valence && biases.valence < -0.05) parts.push(`🌧️ Меланхолия ${valencePct}%`);

      if (biases.tempo && Math.abs(biases.tempo) > 0.05) parts.push(`⏱️ ${tempoVal} BPM`);

      if (parts.length > 0) {
        reason = parts.join(" · ");
      }
    }
    return {
      artist: item.track.artist,
      title: item.track.title,
      album: item.track.album,
      genre: item.track.genre,
      ytdlId: item.track.ytdl_id,
      similarity: Math.round(sim * 100) / 100,
      features: item.features,
      reason
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
  db = getDb(),
  biases?: AcousticBiases
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

  // Apply user-defined acoustic biases to shift seed vector
  seed = applyAcousticBiases(seed, biases);

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

export interface CatalogSearchResult {
  id: number;
  artist: string;
  title: string;
  album: string;
  genre: string;
  duration_sec: number;
  energy?: number;
  tempo?: number;
  valence?: number;
  is_local?: boolean;
  track_id?: number;
}

// Global Instant Search across 3.27M catalog tracks
export function searchExternalCatalog(
  rawQuery: string,
  limit = 40,
  offset = 0,
  db = getDb()
): { count: number; tracks: CatalogSearchResult[] } {
  const q = rawQuery.trim();
  if (!q) {
    return { count: 0, tracks: [] };
  }

  type CatRow = {
    id: number;
    artist: string;
    title: string;
    album: string;
    genre: string;
    duration_sec: number;
    features_json: string;
  };

  let rows: CatRow[] = [];

  // Check if query is formatted as "Artist - Title"
  if (q.includes(" - ")) {
    const parts = q.split(" - ");
    const artistPrefix = parts[0].trim() + "%";
    const titlePrefix = parts.slice(1).join(" - ").trim() + "%";
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, features_json
      FROM external_catalog
      WHERE artist LIKE ? AND title LIKE ? AND is_available = 1
      LIMIT ? OFFSET ?
    `).all(artistPrefix, titlePrefix, limit, offset) as CatRow[];
  } else {
    // 1. Instant prefix match on artist or title (hits idx_ext_cat_artist_nocase & idx_ext_cat_title_nocase)
    const prefix = q + "%";
    rows = db.prepare(`
      SELECT id, artist, title, album, genre, duration_sec, features_json
      FROM external_catalog
      WHERE (artist LIKE ? OR title LIKE ?) AND is_available = 1
      LIMIT ? OFFSET ?
    `).all(prefix, prefix, limit, offset) as CatRow[];

    // 2. If fewer results than desired and query length >= 3, supplement with word boundary match '% q%'
    if (rows.length < limit && q.length >= 3 && offset === 0) {
      const existingIds = new Set(rows.map(r => r.id));
      const wordMatch = "% " + q + "%";
      const remainingLimit = limit - rows.length;
      const extraRows = db.prepare(`
        SELECT id, artist, title, album, genre, duration_sec, features_json
        FROM external_catalog
        WHERE (artist LIKE ? OR title LIKE ?) AND is_available = 1
        LIMIT ?
      `).all(wordMatch, wordMatch, remainingLimit) as CatRow[];

      for (const r of extraRows) {
        if (!existingIds.has(r.id)) {
          rows.push(r);
          existingIds.add(r.id);
        }
      }
    }
  }

  let hasTracksTable = true;
  try {
    hasTracksTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tracks'").get();
  } catch {
    hasTracksTable = false;
  }

  // Check local availability in `tracks` table for each result
  const tracks: CatalogSearchResult[] = [];
  for (const r of rows) {
    let energy: number | undefined;
    let tempo: number | undefined;
    let valence: number | undefined;

    if (r.features_json) {
      try {
        const feat = JSON.parse(r.features_json);
        energy = feat.energy;
        tempo = feat.tempo;
        valence = feat.valence;
      } catch {}
    }

    let local: { id: number } | undefined;
    if (hasTracksTable) {
      try {
        local = db.prepare(`
          SELECT id FROM tracks 
          WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))
          LIMIT 1
        `).get(r.artist, r.title) as { id: number } | undefined;
      } catch {}
    }

    tracks.push({
      id: r.id,
      artist: r.artist,
      title: r.title,
      album: r.album || "External Catalog",
      genre: r.genre || "General",
      duration_sec: Math.round(r.duration_sec || 180),
      energy: typeof energy === "number" ? Math.round(energy * 100) : undefined,
      tempo: typeof tempo === "number" ? Math.round(tempo) : undefined,
      valence: typeof valence === "number" ? Math.round(valence * 100) : undefined,
      is_local: !!local,
      track_id: local?.id
    });
  }

  return { count: tracks.length, tracks };
}

