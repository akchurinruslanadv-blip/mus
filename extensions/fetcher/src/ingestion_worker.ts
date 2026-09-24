// extensions/fetcher/src/ingestion_worker.ts: Continuous Playlist Ingestion & 512D Embedding Worker
import { config } from "./config.ts";
import {
  getDb,
  getNextPendingIngestionTask,
  getNextTrackMissing512Embedding,
  updateIngestionTaskStatus,
  getIngestionStatusSummary,
  findTrackByArtistTitle,
  has512Embedding,
  addToFavorites,
  pinTrack,
  getActiveSession
} from "./db.ts";
import { fetchTrackAudio } from "./fetcher.ts";
import { compute512DEmbedding } from "./embedder_client.ts";
import { enforceLruCache } from "./lru.ts";
import { IngestionStatusSummary, IngestionStatus } from "./types.ts";

export class IngestionWorker {
  private isRunning = false;
  private isPausedState = false;
  private currentTrackInfo?: { artist: string; title: string; status: IngestionStatus };
  private timerId?: ReturnType<typeof setTimeout>;

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("[ingestion-worker] Started background playlist ingestion worker.");
    this.scheduleNext(100);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timerId !== undefined) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
    console.log("[ingestion-worker] Stopped background playlist ingestion worker.");
  }

  public pause(): void {
    this.isPausedState = true;
    console.log("[ingestion-worker] Paused ingestion worker.");
  }

  public resume(): void {
    this.isPausedState = false;
    console.log("[ingestion-worker] Resumed ingestion worker.");
    if (this.isRunning && this.timerId === undefined) {
      this.scheduleNext(100);
    }
  }

  public isPaused(): boolean {
    return this.isPausedState;
  }

  public getStatus(): IngestionStatusSummary {
    const summary = getIngestionStatusSummary();
    return {
      ...summary,
      isPaused: this.isPausedState,
      currentTrack: this.currentTrackInfo
    };
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timerId = setTimeout(async () => {
      this.timerId = undefined;
      await this.step();
    }, delayMs);
  }

  public async step(): Promise<boolean> {
    if (this.isPausedState || !this.isRunning) {
      this.scheduleNext(2000);
      return false;
    }

    const task = getNextPendingIngestionTask();
    if (!task) {
      // Backlog sweep: Check if any existing library tracks are missing 512D embeddings
      const missing = getNextTrackMissing512Embedding();
      if (missing && missing.path) {
        try {
          const fileExists = await Deno.stat(missing.path).then(() => true).catch(() => false);
          if (fileExists) {
            this.currentTrackInfo = {
              artist: missing.artist,
              title: missing.title,
              status: "embedding"
            };
            console.log(`[ingestion-worker] Backlog 512D embedding for: ${missing.artist} - ${missing.title}`);
            await compute512DEmbedding(missing.path, missing.id);
            this.scheduleNext(500);
            return true;
          }
        } catch {}
      }

      this.currentTrackInfo = undefined;
      // Idle poll every 3 seconds
      this.scheduleNext(3000);
      return false;
    }

    this.currentTrackInfo = {
      artist: task.artist,
      title: task.title,
      status: "downloading"
    };

    updateIngestionTaskStatus(task.id, "downloading");

    try {
      // 1. Check if track is already registered in DB
      let trackId: number | undefined;
      let filePath: string | undefined;
      let alreadyHas512 = false;

      const existing = findTrackByArtistTitle(task.artist, task.title);
      if (existing) {
        trackId = existing.id;
        filePath = existing.path;
        alreadyHas512 = existing.hasEmbedding;
      }

      // 2. If track doesn't exist or file is missing, fetch audio with 1 retry
      if (!filePath || !trackId) {
        let fetchRes = await fetchTrackAudio(task.artist, task.title, {
          mode: task.pinForever ? "pin" : "cache",
          fallbackSearch: true
        });

        // 1 retry after 2s for transient YouTube / network hiccup
        if (!fetchRes.success) {
          await new Promise(r => setTimeout(r, 2000));
          fetchRes = await fetchTrackAudio(task.artist, task.title, {
            mode: task.pinForever ? "pin" : "cache",
            fallbackSearch: true
          });
        }

        if (!fetchRes.success || !fetchRes.filePath || !fetchRes.trackId) {
          updateIngestionTaskStatus(task.id, "failed", fetchRes.error || "Audio fetch failed");
          this.currentTrackInfo = undefined;
          this.scheduleNext(1500);
          return false;
        }

        trackId = fetchRes.trackId;
        filePath = fetchRes.filePath;
      }

      // 3. Apply Favorite & Pin options
      if (task.addToFavorites && trackId) {
        addToFavorites(trackId);
      }
      if (task.pinForever && trackId) {
        pinTrack(trackId);
      }

      // 4. Extract 512D CLAP embedding if requested and not already computed
      if (task.autoEmbed512 && trackId && filePath && !alreadyHas512) {
        this.currentTrackInfo = {
          artist: task.artist,
          title: task.title,
          status: "embedding"
        };
        updateIngestionTaskStatus(task.id, "embedding", undefined, trackId);

        console.log(`[ingestion-worker] Extracting 512D embedding for: ${task.artist} - ${task.title}`);
        const embedRes = await compute512DEmbedding(filePath, trackId);
        if (!embedRes.ok) {
          console.warn(`[ingestion-worker] Embedder warning for ${trackId}:`, embedRes.error);
        }
      }

      // 5. Enforce 3 GB cache with 512D vector protection
      if (!task.pinForever) {
        await enforceLruCache();
      }

      // 6. Mark task ready
      updateIngestionTaskStatus(task.id, "ready", undefined, trackId);
      console.log(`[ingestion-worker] Finished processing: ${task.artist} - ${task.title}`);

      // 7. CPU Throttling & Playback Yield
      // If user is actively listening, yield CPU by waiting 2500ms, otherwise 1000ms
      const session = getActiveSession();
      const delay = (session && session.currentId) ? 2500 : 1000;
      this.scheduleNext(delay);
      return true;

    } catch (err) {
      console.error(`[ingestion-worker] Error processing task ${task.id}:`, err);
      updateIngestionTaskStatus(task.id, "failed", String(err));
      this.currentTrackInfo = undefined;
      this.scheduleNext(2000);
      return false;
    }
  }
}

export const ingestionWorker = new IngestionWorker();
