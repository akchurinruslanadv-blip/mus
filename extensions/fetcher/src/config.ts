// extensions/fetcher/src/config.ts: Configuration & Environment Manager
import * as path from "@std/path";

const SCRIPT_DIR = path.dirname(path.fromFileUrl(import.meta.url));
const EXTENSION_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(EXTENSION_ROOT, "..", "..");

export const config = {
  // Ports & network
  port: parseInt(Deno.env.get("FETCHER_PORT") || "8787"),
  playerUrl: Deno.env.get("MUSIK_PLAYER_URL") || "http://127.0.0.1:8786",
  
  // Storage & Limits
  cacheMaxGb: parseFloat(Deno.env.get("CACHE_MAX_GB") || "3.0"),
  
  // Paths
  projectRoot: PROJECT_ROOT,
  extensionRoot: EXTENSION_ROOT,
  binDir: path.resolve(PROJECT_ROOT, "bin"),
  dynamicDir: path.resolve(PROJECT_ROOT, "dynamic"),
  favoritesDir: path.resolve(PROJECT_ROOT, "data", "music", "favorites"),
  dbPath: path.resolve(PROJECT_ROOT, "data", "db", "musik.db"),
  cookiesPath: Deno.env.get("COOKIES_PATH") || path.resolve(PROJECT_ROOT, "cookies.txt"),
  
  // Tooling (cross-platform with local bin and system fallbacks)
  ytdlpPath: Deno.env.get("YTDLP_PATH") || (Deno.build.os === "windows" ? path.resolve(PROJECT_ROOT, "bin", "yt-dlp.exe") : "yt-dlp"),
  pythonPath: Deno.env.get("PYTHON_PATH") || (Deno.build.os === "windows" ? path.resolve(PROJECT_ROOT, "bin", "python", "python.exe") : "python3"),
  embedderPath: path.resolve(EXTENSION_ROOT, "scripts", "embedder.py"),
  
  // Audio preferences
  audioFormat: "251/140/ba", // Opus 160k first, AAC 128k second, bestaudio fallback

  // Music Guard & Content Filtering (P4: configurable thresholds)
  minTrackDurationSec: parseFloat(Deno.env.get("MIN_TRACK_DURATION_SEC") || "40"),
  maxTrackDurationSec: parseFloat(Deno.env.get("MAX_TRACK_DURATION_SEC") || "720"),
  maxSpeechiness: parseFloat(Deno.env.get("MAX_SPEECHINESS") || "0.35"),
  nonMusicKeywords: (Deno.env.get("NON_MUSIC_KEYWORDS") || "podcast,подкаст,интервью,interview,audiobook,аудиокнига,читает,стендап,stand-up,full album,реакция,reaction")
    .split(",")
    .map(k => k.trim().toLowerCase())
    .filter(Boolean),

  // Auto-update yt-dlp on startup (P2)
  autoUpdateYtdlp: Deno.env.get("AUTO_UPDATE_YTDLP") === "1" || false,

  // Performance & Concurrency
  maxCpuThreads: parseInt(Deno.env.get("MAX_CPU_THREADS") || "2"),
  watchDebounceMs: 250,
};

