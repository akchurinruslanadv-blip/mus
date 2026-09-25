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

// Resolves authentic 12D acoustic seed for any track (direct catalog match, audio features table, or 512D nearest acoustic donor)
export function resolveSeedAcousticFeatures(trackId: number, db = getDb()): AcousticFeatures12D {
  // 1. Direct match in external_catalog
  try {
    const directRow = db.prepare(`
      SELECT ec.features_json 
      FROM tracks t
      JOIN external_catalog ec ON ec.artist = t.artist COLLATE NOCASE AND ec.title = t.title COLLATE NOCASE
      WHERE t.id = ? AND ec.features_json IS NOT NULL
      LIMIT 1
    `).get(trackId) as { features_json?: string } | undefined;

    if (directRow?.features_json) {
      const parsed = JSON.parse(directRow.features_json);
      if (parsed && typeof parsed.tempo === "number") return parsed;
    }
  } catch {}

  // 2. Check if features table has bpm / mode / lufs for this track
  try {
    const fRow = db.prepare(`
      SELECT bpm, mode, lufs, embedding FROM features WHERE track_id = ?
    `).get(trackId) as { bpm?: number; mode?: string; lufs?: number; embedding?: Uint8Array } | undefined;

    // 3. Find closest 512D acoustic donor among tracks with known 12D features
    if (fRow?.embedding && fRow.embedding.length === 2048) {
      const u8 = new Uint8Array(fRow.embedding);
      const targetVec = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);

      // Fetch sample of library tracks with both 512D embedding and external 12D features
      const donorRows = db.prepare(`
        SELECT f.embedding, ec.features_json
        FROM tracks t
        JOIN features f ON f.track_id = t.id
        JOIN external_catalog ec ON ec.artist = t.artist COLLATE NOCASE AND ec.title = t.title COLLATE NOCASE
        WHERE f.status = 'ready' AND length(f.embedding) = 2048 AND ec.features_json IS NOT NULL
        LIMIT 60
      `).all() as { embedding: Uint8Array; features_json: string }[];

      let bestScore = -1;
      let bestFeatures: AcousticFeatures12D | null = null;

      for (const donor of donorRows) {
        const dU8 = new Uint8Array(donor.embedding);
        const dF32 = new Float32Array(dU8.buffer, dU8.byteOffset, dU8.byteLength / 4);
        let dot = 0;
        for (let i = 0; i < 512; i++) dot += targetVec[i] * dF32[i];
        if (dot > bestScore) {
          bestScore = dot;
          try {
            bestFeatures = JSON.parse(donor.features_json);
          } catch {}
        }
      }

      if (bestFeatures) {
        if (fRow.bpm && fRow.bpm > 40 && fRow.bpm < 240) {
          bestFeatures.tempo = fRow.bpm;
        }
        return bestFeatures;
      }
    }
  } catch {}

  // 4. Default graceful fallback
  return {
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

// --- 512D Neural to 12D Acoustic Vector Projection Engine ---

type Anchor = {
  vec: Float32Array;
  features: AcousticFeatures12D;
};

let cachedAnchors: Anchor[] | null = null;
let lastAnchorsLoadTime = 0;

export function loadAcousticAnchors(db = getDb(), forceReload = false): Anchor[] {
  const now = Date.now();
  if (cachedAnchors && !forceReload && (now - lastAnchorsLoadTime < 300000)) {
    return cachedAnchors;
  }

  const rows = db.prepare(`
    SELECT f.embedding, ec.features_json 
    FROM tracks t 
    JOIN features f ON f.track_id = t.id 
    JOIN external_catalog ec ON ec.artist = t.artist COLLATE NOCASE AND ec.title = t.title COLLATE NOCASE 
    WHERE f.embedding IS NOT NULL AND length(f.embedding) = 2048
    LIMIT 600
  `).all() as { embedding: Uint8Array; features_json: string }[];

  const anchors: Anchor[] = [];
  for (const r of rows) {
    try {
      const f = JSON.parse(r.features_json);
      const u8 = new Uint8Array(r.embedding);
      const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
      anchors.push({ vec: f32, features: f });
    } catch {}
  }

  cachedAnchors = anchors;
  lastAnchorsLoadTime = now;
  return anchors;
}

function dot512(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Convert 512D CLAP embedding into full 12D acoustic properties via acoustic anchor projection
export function project512Dto12D(vec: Float32Array, db = getDb(), k = 7): AcousticFeatures12D {
  const anchors = loadAcousticAnchors(db);
  if (anchors.length === 0) {
    return {
      danceability: 0.6,
      energy: 0.6,
      valence: 0.5,
      acousticness: 0.2,
      tempo: 120,
      speechiness: 0.05,
      loudness: -8,
      instrumentalness: 0.05,
      liveness: 0.1,
      key: 0,
      mode: 1
    };
  }

  const scored = anchors.map(a => ({ anchor: a, sim: dot512(vec, a.vec) }));
  scored.sort((x, y) => y.sim - x.sim);

  const topK = scored.slice(0, Math.min(k, scored.length));
  let totalW = 0;
  let dance = 0, energy = 0, valence = 0, acoustic = 0, tempo = 0, speech = 0, loud = 0, inst = 0, live = 0;

  for (const item of topK) {
    const w = Math.max(0.001, Math.exp(item.sim * 5));
    totalW += w;
    const f = item.anchor.features;
    dance += (f.danceability || 0.5) * w;
    energy += (f.energy || 0.5) * w;
    valence += (f.valence || 0.5) * w;
    acoustic += (f.acousticness || 0.2) * w;
    tempo += (f.tempo || 120) * w;
    speech += (f.speechiness || 0.05) * w;
    loud += (f.loudness || -8) * w;
    inst += (f.instrumentalness || 0) * w;
    live += (f.liveness || 0.1) * w;
  }

  return {
    danceability: Math.round((dance / totalW) * 1000) / 1000,
    energy: Math.round((energy / totalW) * 1000) / 1000,
    valence: Math.round((valence / totalW) * 1000) / 1000,
    acousticness: Math.round((acoustic / totalW) * 1000) / 1000,
    tempo: Math.round((tempo / totalW) * 10) / 10,
    speechiness: Math.round((speech / totalW) * 1000) / 1000,
    loudness: Math.round((loud / totalW) * 10) / 10,
    instrumentalness: Math.round((inst / totalW) * 1000) / 1000,
    liveness: Math.round((live / totalW) * 1000) / 1000,
    key: topK[0]?.anchor.features.key || 0,
    mode: topK[0]?.anchor.features.mode || 1
  };
}

// Ensure ALL local tracks with 512D embeddings are registered into 12D external_catalog
export function syncAllLocalTracksTo12DCatalog(db = getDb()): number {
  const missing = db.prepare(`
    SELECT t.id, t.artist, t.title, t.album, t.duration, f.embedding, f.bpm, f.lufs
    FROM tracks t
    JOIN features f ON f.track_id = t.id
    WHERE f.embedding IS NOT NULL AND length(f.embedding) = 2048
      AND NOT EXISTS (
        SELECT 1 FROM external_catalog ec 
        WHERE ec.artist = t.artist COLLATE NOCASE AND ec.title = t.title COLLATE NOCASE
      )
  `).all() as any[];

  if (missing.length === 0) return 0;

  console.log(`[12D-bridge] Projecting ${missing.length} unmapped local 512D tracks into 12D catalog...`);
  let count = 0;
  const now = new Date().toISOString();

  db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO external_catalog (artist, title, album, duration_sec, genre, features_json, is_available, added_at)
      VALUES (?, ?, ?, ?, 'Local Library', ?, 1, ?)
      ON CONFLICT(artist, title) DO UPDATE SET features_json = excluded.features_json
    `);

    for (const t of missing) {
      try {
        const u8 = new Uint8Array(t.embedding);
        const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
        const projected = project512Dto12D(f32, db);
        if (t.bpm && t.bpm > 40) projected.tempo = Math.round(t.bpm * 10) / 10;
        if (t.lufs) projected.loudness = Math.round(t.lufs * 10) / 10;

        insertStmt.run(
          t.artist,
          t.title,
          t.album || "Local Library",
          t.duration || 180,
          JSON.stringify(projected),
          now
        );
        count++;
      } catch {}
    }
  })();

  console.log(`[12D-bridge] Successfully projected and indexed ${count} tracks into 12D catalog!`);
  return count;
}

let cachedCentroid: Float32Array | null = null;
let lastCentroidCompute = 0;

// Compute normalized 512D acoustic centroid of user favorites
export function getFavoritesCentroid(db = getDb()): Float32Array | null {
  const now = Date.now();
  if (cachedCentroid && now - lastCentroidCompute < 60000) {
    return cachedCentroid;
  }
  let rows = db.prepare(`
    SELECT f.embedding
    FROM favorites fav
    JOIN features f ON f.track_id = fav.track_id
    WHERE f.embedding IS NOT NULL AND length(f.embedding) = 2048
  `).all() as { embedding: Uint8Array | ArrayBuffer }[];

  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT f.embedding
      FROM tracks t
      JOIN features f ON f.track_id = t.id
      WHERE f.embedding IS NOT NULL AND length(f.embedding) = 2048
      ORDER BY t.play_count DESC
      LIMIT 100
    `).all() as { embedding: Uint8Array | ArrayBuffer }[];
  }

  if (rows.length === 0) return null;

  const centroid = new Float32Array(512);
  let count = 0;
  for (const r of rows) {
    try {
      const u8 = new Uint8Array(r.embedding);
      const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
      if (f32.length === 512) {
        for (let i = 0; i < 512; i++) {
          centroid[i] += f32[i];
        }
        count++;
      }
    } catch {}
  }

  if (count === 0) return null;

  let norm = 0;
  for (let i = 0; i < 512; i++) {
    centroid[i] /= count;
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < 512; i++) {
      centroid[i] /= norm;
    }
  }

  cachedCentroid = centroid;
  lastCentroidCompute = now;
  return centroid;
}

// Compute cosine similarity between 512D track embedding and favorites centroid
export function score512AgainstCentroid(vec: Float32Array, centroid: Float32Array): number {
  let dot = 0;
  let normA = 0;
  for (let i = 0; i < 512; i++) {
    dot += vec[i] * centroid[i];
    normA += vec[i] * vec[i];
  }
  normA = Math.sqrt(normA);
  const rawCos = normA > 0 ? dot / normA : 0;
  return Math.max(0.01, Math.min(0.99, rawCos));
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
    JOIN external_catalog c ON c.artist = t.artist COLLATE NOCASE AND c.title = t.title COLLATE NOCASE
    WHERE c.features_json IS NOT NULL
    LIMIT 60
  `).all() as FeatRow[];

  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT c.features_json
      FROM tracks t
      JOIN external_catalog c ON c.artist = t.artist COLLATE NOCASE AND c.title = t.title COLLATE NOCASE
      WHERE c.features_json IS NOT NULL
      ORDER BY t.play_count DESC, t.id DESC
      LIMIT 60
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

