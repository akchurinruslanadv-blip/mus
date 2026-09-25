// extensions/fetcher/src/radio_pool.ts: Speculative Pre-Indexing Pool for Zero-Latency Radio
import { config } from "./config.ts";
import { getDb, getActiveSession, findTrackByArtistTitle, has512Embedding, getRadioSettings, isTrackFamiliar } from "./db.ts";
import { find12DCandidates, getColdStartSeeds, getFavoritesCentroid, score512AgainstCentroid, resolveSeedAcousticFeatures } from "./dataset_bridge.ts";
import { fetchTrackAudio } from "./fetcher.ts";
import { compute512DEmbedding } from "./embedder_client.ts";
import { enforceLruCache } from "./lru.ts";
import { RadioPoolCandidate, AcousticFeatures12D, AcousticBiases } from "./types.ts";

export class RadioPoolManager {
  private pool: RadioPoolCandidate[] = [];
  private isManaging = false;
  private isBusy = false;
  private checkIntervalId?: ReturnType<typeof setInterval>;
  private readonly targetPoolSize = 2;
  private isProcessing = false;

  public start(): void {
    if (this.isManaging) return;
    this.isManaging = true;
    console.log("[radio-pool] Started Active 512D Pre-Indexing Pool Manager.");
    // Periodic check every 30s to keep warm candidates in pool without wasting CPU
    this.checkIntervalId = setInterval(() => {
      this.maintainPool().catch(err => {
        console.error("[radio-pool] Error maintaining pool:", err);
      });
    }, 30000);
    // Initial run
    this.maintainPool().catch(() => {});
  }

  public stop(): void {
    this.isManaging = false;
    if (this.checkIntervalId !== undefined) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = undefined;
    }
    console.log("[radio-pool] Stopped Speculative Pre-Indexing Pool Manager.");
  }

  public getPool(): RadioPoolCandidate[] {
    return [...this.pool];
  }

  // Returns all hot candidates that have audio and 512D embeddings ready, sorted by 512D score descending
  public getReadyPool(): RadioPoolCandidate[] {
    return this.pool
      .filter(c => c.isReady && !!c.trackId)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  public async refreshPool(biases?: AcousticBiases): Promise<void> {
    this.pool = [];
    this.isBusy = false;
    await this.maintainPool(biases);
  }

  public async maintainPool(biases?: AcousticBiases): Promise<void> {
    if (this.isBusy || !this.isManaging || this.isProcessing) return;
    this.isBusy = true;

    try {
      const db = getDb();
      const session = getActiveSession(db);

      // Only run speculative pre-indexing if there is an active session playing
      if (!session || !session.currentId) {
        return;
      }

      // Clean up consumed or expired tracks from pool
      const playedIds = new Set<number>();
      if (session.currentId) playedIds.add(session.currentId);
      const qList = Array.isArray(session.queue) ? session.queue : [];
      for (const item of qList) {
        if (item?.track_id) playedIds.add(item.track_id);
      }

      // Filter out tracks that are already in playback queue
      this.pool = this.pool.filter(c => !c.trackId || !playedIds.has(c.trackId));

      // If pool is below target size, replenish with fresh acoustic candidates
      if (this.pool.length < this.targetPoolSize) {
        await this.replenishPool(session, biases);
      }

      // Process next unindexed candidate in pool (one at a time)
      const unready = this.pool.find(c => !c.isReady);
      if (unready) {
        this.isProcessing = true;
        try {
          await this.indexCandidate(unready);
        } finally {
          this.isProcessing = false;
        }
      }
    } finally {
      this.isBusy = false;
    }
  }

  private async replenishPool(session: ReturnType<typeof getActiveSession>, biases?: AcousticBiases): Promise<void> {
    const db = getDb();
    const excludeSet = new Set<string>();

    for (const c of this.pool) {
      excludeSet.add(`${c.artist} - ${c.title}`.toLowerCase());
    }

    if (session && Array.isArray(session.queue)) {
      for (const q of session.queue) {
        if (q?.artist && q?.title) {
          excludeSet.add(`${q.artist} - ${q.title}`.toLowerCase());
        }
      }
    }

    // Add inactive or familiar tracks to excludeSet so find12DCandidates skips them
    try {
      const inactiveOrFamiliar = db.prepare(`
        SELECT LOWER(t.artist) as artist, LOWER(t.title) as title
        FROM tracks t
        WHERE t.is_active = 0
           OR t.id IN (SELECT track_id FROM listening_history)
           OR t.id IN (SELECT track_id FROM favorites)
      `).all() as { artist: string; title: string }[];
      for (const r of inactiveOrFamiliar) {
        excludeSet.add(`${r.artist} - ${r.title}`);
      }
    } catch {}

    // Read active biases if not passed
    const activeBiases = biases || (session?.id ? getRadioSettings(session.id, db).biases : undefined);

    // Determine authentic acoustic seed (using catalog match or 512D nearest acoustic donor)
    const seedFeatures: AcousticFeatures12D = session?.currentId
      ? resolveSeedAcousticFeatures(session.currentId, db)
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

    const needed = this.targetPoolSize - this.pool.length;
    const candidates = find12DCandidates(seedFeatures, needed * 2, excludeSet, db, activeBiases);

    for (const hit of candidates) {
      if (this.pool.length >= this.targetPoolSize) break;

      const existing = findTrackByArtistTitle(hit.artist, hit.title, db);
      // Skip tracks already familiar or inactive (e.g. previously evicted discordant tracks)
      if (existing && (!existing.isActive || isTrackFamiliar(existing.id, db))) {
        continue;
      }
      const isAlreadyEmbedded = existing ? existing.hasEmbedding : false;

      this.pool.push({
        trackId: existing?.id,
        artist: hit.artist,
        title: hit.title,
        ytdlId: hit.ytdlId,
        source: "external_12d",
        filePath: existing?.path,
        has512Embedding: isAlreadyEmbedded,
        isReady: isAlreadyEmbedded && !!existing?.path,
        score: hit.similarity,
        addedAt: new Date().toISOString()
      });
    }

    // Cold-start fallback if no candidates found
    if (this.pool.length < this.targetPoolSize) {
      const seeds = getColdStartSeeds(this.targetPoolSize - this.pool.length, db);
      for (const s of seeds) {
        if (this.pool.some(c => c.artist.toLowerCase() === s.artist.toLowerCase() && c.title.toLowerCase() === s.title.toLowerCase())) {
          continue;
        }
        this.pool.push({
          artist: s.artist,
          title: s.title,
          source: "external_12d",
          has512Embedding: false,
          isReady: false,
          score: 0.8,
          addedAt: new Date().toISOString()
        });
      }
    }
  }

  private async indexCandidate(candidate: RadioPoolCandidate): Promise<void> {
    console.log(`[radio-pool] Speculative pre-indexing candidate: ${candidate.artist} - ${candidate.title}`);

    try {
      // 1. Fetch audio into dynamic cache
      const fetchRes = await fetchTrackAudio(candidate.artist, candidate.title, {
        mode: "cache",
        preferredYtdlId: candidate.ytdlId,
        fallbackSearch: true
      });

      if (!fetchRes.success || !fetchRes.filePath || !fetchRes.trackId) {
        console.warn(`[radio-pool] Pre-fetch failed for ${candidate.artist} - ${candidate.title}: ${fetchRes.error}`);
        // Remove failed candidate from pool
        this.pool = this.pool.filter(c => c !== candidate);
        return;
      }

      candidate.trackId = fetchRes.trackId;
      candidate.filePath = fetchRes.filePath;

      // 2. Compute 512D CLAP embedding & score against favorites centroid
      const db = getDb();
      let alreadyHas512 = has512Embedding(fetchRes.trackId);
      if (!alreadyHas512) {
        try {
          await compute512DEmbedding(fetchRes.filePath, fetchRes.trackId);
          alreadyHas512 = has512Embedding(fetchRes.trackId);
        } catch (embErr) {
          console.warn(`[radio-pool] 512D CLAP embedding calculation failed:`, embErr);
        }
      }

      if (alreadyHas512) {
        const featRow = db.prepare(`SELECT embedding FROM features WHERE track_id = ? AND length(embedding) = 2048`).get(fetchRes.trackId) as { embedding?: Uint8Array } | undefined;
        if (featRow?.embedding) {
          try {
            const u8 = new Uint8Array(featRow.embedding);
            const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
            const centroid = getFavoritesCentroid(db);
            if (centroid) {
              const score512 = score512AgainstCentroid(f32, centroid);
              candidate.score = Math.round(score512 * 100) / 100;
              candidate.explanation = `🧠 512D Отбор (${Math.round(score512 * 100)}% вкус)`;

              // Smart eviction of discordant tracks:
              // If candidate is hellishly far from user taste (score < 0.40):
              // Delete the downloaded audio file to save disk space,
              // but KEEP track info, ytdl_id, and 512D vector in SQLite so we remember it.
              if (score512 < 0.40) {
                console.log(`[radio-pool] Discordant candidate (512D score: ${candidate.score} < 0.40): ${candidate.artist} - ${candidate.title}. Evicting audio file, preserving 512D embedding in DB.`);
                if (candidate.filePath) {
                  try {
                    await Deno.remove(candidate.filePath);
                  } catch (remErr) {
                    console.warn(`[radio-pool] Failed to remove evicted audio file:`, remErr);
                  }
                }
                try {
                  db.prepare(`UPDATE tracks SET path = '', is_active = 0 WHERE id = ?`).run(candidate.trackId);
                  db.prepare(`
                    INSERT INTO listening_history (track_id, ts, source, action, reason)
                    VALUES (?, ?, 'radio_pool', 'discard', 'discordant_512')
                  `).run(candidate.trackId, new Date().toISOString());
                } catch (dbErr) {
                  console.warn(`[radio-pool] Failed to update DB on eviction:`, dbErr);
                }

                // Remove from pool and trigger replenishment
                this.pool = this.pool.filter(c => c !== candidate);
                setTimeout(() => this.maintainPool().catch(() => {}), 500);
                return;
              }
            }
          } catch (scoringErr) {
            console.warn(`[radio-pool] Error during 512D centroid scoring:`, scoringErr);
          }
        }
      }

      candidate.has512Embedding = alreadyHas512;
      candidate.isReady = true;

      // Sort pool so highest 512D scored candidates are consumed first
      this.pool.sort((a, b) => (b.score || 0) - (a.score || 0));

      // 3. Keep cache within 3 GB
      await enforceLruCache();

      // 4. Notify Go core player to reload memory index
      try {
        await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
      } catch {}

      console.log(`[radio-pool] Candidate is hot and ready in pool: ${candidate.artist} - ${candidate.title} (512D score: ${candidate.score || 0})`);
    } catch (err) {
      console.error(`[radio-pool] Error indexing pool candidate:`, err);
      this.pool = this.pool.filter(c => c !== candidate);
    }
  }
}

export const radioPoolManager = new RadioPoolManager();
