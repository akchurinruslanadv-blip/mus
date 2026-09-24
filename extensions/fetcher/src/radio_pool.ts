// extensions/fetcher/src/radio_pool.ts: Speculative Pre-Indexing Pool for Zero-Latency Radio
import { config } from "./config.ts";
import { getDb, getActiveSession, findTrackByArtistTitle, has512Embedding, getRadioSettings } from "./db.ts";
import { find12DCandidates, getColdStartSeeds } from "./dataset_bridge.ts";
import { fetchTrackAudio } from "./fetcher.ts";
import { compute512DEmbedding } from "./embedder_client.ts";
import { enforceLruCache } from "./lru.ts";
import { RadioPoolCandidate, AcousticFeatures12D, AcousticBiases } from "./types.ts";

export class RadioPoolManager {
  private pool: RadioPoolCandidate[] = [];
  private isManaging = false;
  private isBusy = false;
  private checkIntervalId?: ReturnType<typeof setInterval>;
  private readonly targetPoolSize = 5;
  private isProcessing = false;


  public start(): void {
    if (this.isManaging) return;
    this.isManaging = true;
    console.log("[radio-pool] Started Active 512D Pre-Indexing Pool Manager.");
    // Periodic check every 15s to keep fresh diverse candidates in pool
    this.checkIntervalId = setInterval(() => {
      this.maintainPool().catch(err => {
        console.error("[radio-pool] Error maintaining pool:", err);
      });
    }, 15000);
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

    // Read active biases if not passed
    const activeBiases = biases || (session?.id ? getRadioSettings(session.id, db).biases : undefined);

    // Determine current acoustic seed
    let seedFeatures: AcousticFeatures12D | undefined;

    if (session && session.currentId) {
      const curRow = db.prepare(`
        SELECT ec.features_json 
        FROM tracks t
        LEFT JOIN external_catalog ec ON LOWER(ec.artist) = LOWER(t.artist) AND LOWER(ec.title) = LOWER(t.title)
        WHERE t.id = ?
      `).get(session.currentId) as { features_json?: string } | undefined;

      if (curRow?.features_json) {
        try {
          seedFeatures = JSON.parse(curRow.features_json);
        } catch {}
      }
    }

    // Default neutral seed if no current track features
    if (!seedFeatures) {
      seedFeatures = {
        danceability: 0.6,
        energy: 0.6,
        key: 0,
        loudness: -8,
        mode: 1,
        speechiness: 0.05,
        acousticness: 0.2,
        instrumentalness: 0,
        liveness: 0.1,
        valence: 0.5,
        tempo: 120
      };
    }

    const needed = this.targetPoolSize - this.pool.length;
    const candidates = find12DCandidates(seedFeatures, needed * 2, excludeSet, db, activeBiases);

    for (const hit of candidates) {
      if (this.pool.length >= this.targetPoolSize) break;

      const existing = findTrackByArtistTitle(hit.artist, hit.title, db);
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

      // 2. Compute 512D embedding in background if missing
      const alreadyHas512 = has512Embedding(fetchRes.trackId);
      if (!alreadyHas512) {
        compute512DEmbedding(fetchRes.filePath, fetchRes.trackId).catch(() => {});
      }

      candidate.has512Embedding = true;
      candidate.isReady = true;

      // 3. Keep cache within 3 GB
      await enforceLruCache();

      // 4. Notify Go core player to reload memory index
      try {
        await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
      } catch {}

      console.log(`[radio-pool] Candidate is hot and ready in pool: ${candidate.artist} - ${candidate.title}`);
    } catch (err) {
      console.error(`[radio-pool] Error indexing pool candidate:`, err);
      this.pool = this.pool.filter(c => c !== candidate);
    }
  }
}

export const radioPoolManager = new RadioPoolManager();
