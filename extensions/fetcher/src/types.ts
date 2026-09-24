// extensions/fetcher/src/types.ts: Core Domain Interfaces & Types

export interface AcousticFeatures12D {
  danceability: number;     // 0.0 - 1.0
  energy: number;           // 0.0 - 1.0
  key: number;              // 0 - 11 (pitch class)
  loudness: number;         // dB (-60 to 0)
  mode: number;             // 0 = minor, 1 = major
  speechiness: number;      // 0.0 - 1.0
  acousticness: number;     // 0.0 - 1.0
  instrumentalness: number; // 0.0 - 1.0
  liveness: number;         // 0.0 - 1.0
  valence: number;          // 0.0 - 1.0 (musical positiveness / mood)
  tempo: number;            // BPM (e.g. 50 - 220)
  duration_sec?: number;    // seconds
}

export interface AcousticBiases {
  energy?: number;       // -0.5 to +0.5
  valence?: number;      // -0.5 to +0.5
  acousticness?: number; // -0.5 to +0.5
  tempo?: number;        // -0.5 to +0.5
}

export interface RadioSettings {
  discoveryRatio: number;
  biases: AcousticBiases;
}

export type StorageLocation = "catalog" | "cached" | "liked" | "pinned";

export interface ExternalCatalogTrack {
  id?: number;
  artist: string;
  title: string;
  album?: string;
  duration_sec: number;
  ytdl_id?: string;
  genre?: string;
  features_json?: string;
  features?: AcousticFeatures12D;
  is_available: boolean;
  added_at: string;
}

export interface FetchOptions {
  mode?: "cache" | "pin";   // "cache" -> dynamic/ (LRU), "pin" -> data/music/favorites/ (permanent)
  preferredYtdlId?: string;
  fallbackSearch?: boolean;
}

export interface FetchResult {
  success: boolean;
  trackId?: number;
  filePath?: string;
  filename?: string;
  durationSec?: number;
  sizeBytes?: number;
  durationMs?: number;
  ytdlId?: string;
  isPinned?: boolean;
  source: "existing" | "youtube_music" | "youtube_fallback";
  error?: string;
}

export interface CacheStats {
  trackCount: number;
  totalBytes: number;
  totalMb: number;
  maxMb: number;
  usagePercent: number;
  pinnedCount: number;
  embedded512Count: number;
  catalogCount: number;
}

export interface EvictionResult {
  evictedFiles: string[];
  freedBytes: number;
  remainingBytes: number;
}

export interface CandidateHit {
  artist: string;
  title: string;
  album?: string;
  genre?: string;
  ytdlId?: string;
  similarity: number; // 0.0 - 1.0
  features: AcousticFeatures12D;
  reason: string;
}

export type IngestionStatus = "pending" | "downloading" | "embedding" | "ready" | "failed" | "skipped";

export interface IngestionTask {
  id?: number;
  artist: string;
  title: string;
  addToFavorites: boolean;
  pinForever: boolean;
  autoEmbed512: boolean;
  status: IngestionStatus;
  trackId?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface IngestionStatusSummary {
  total: number;
  pending: number;
  processing: number;
  ready: number;
  failed: number;
  isPaused: boolean;
  currentTrack?: { artist: string; title: string; status: IngestionStatus };
}

export interface RadioPoolCandidate {
  trackId?: number;
  artist: string;
  title: string;
  ytdlId?: string;
  source: "internal_512" | "external_12d";
  filePath?: string;
  has512Embedding: boolean;
  isReady: boolean;
  score: number;
  addedAt: string;
}
