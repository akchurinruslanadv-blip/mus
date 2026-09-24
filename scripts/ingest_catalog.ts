// scripts/ingest_catalog.ts: Batch Track Digitizer with LRU-Cache Protection
import * as path from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { Database } from "@db/sqlite";
import { enforceLruCache, getCacheStats } from "../extensions/fetcher/src/lru.ts";

const rawFlags = parseArgs(Deno.args, {
  string: ["file", "mode", "db"],
  default: {
    file: "vk_music_2001_tracks.txt",
    mode: "cache", // "cache" (stays in 3GB LRU cache) or "keep" (permanent favorites)
    limit: 5,
    offset: 0,
    db: "data/db/musik.db",
    "cache-gb": 3.0
  }
});

const flags = {
  file: String(rawFlags.file || "vk_music_2001_tracks.txt"),
  mode: String(rawFlags.mode || "cache"),
  limit: Number(rawFlags.limit || 5),
  offset: Number(rawFlags.offset || 0),
  db: String(rawFlags.db || "data/db/musik.db"),
  "cache-gb": Number(rawFlags["cache-gb"] || 3.0)
};

const PROJECT_ROOT = Deno.cwd();
const BIN_DIR = path.join(PROJECT_ROOT, "bin");
const YTDLP_PATH = path.join(BIN_DIR, "yt-dlp.exe");
const PYTHON_PATH = path.join(BIN_DIR, "python", "python.exe");
const EMBEDDER_PATH = path.join(PROJECT_ROOT, "scripts", "embedder.py");
const DYNAMIC_DIR = path.join(PROJECT_ROOT, "dynamic");
const FAVORITES_DIR = path.join(PROJECT_ROOT, "data", "music", "favorites");
const DB_PATH = path.resolve(PROJECT_ROOT, flags.db);

await Deno.mkdir(DYNAMIC_DIR, { recursive: true });
if (flags.mode === "keep") {
  await Deno.mkdir(FAVORITES_DIR, { recursive: true });
}

console.log("==========================================================");
console.log(`[musik-catalog] Starting catalog ingestion & digitization`);
console.log(`[musik-catalog] File: ${flags.file}`);
console.log(`[musik-catalog] Storage: ${flags.mode === "keep" ? "Permanent Library (Favorites)" : `Dynamic Cache (Max: ${flags["cache-gb"]} GB, LRU)`}`);
console.log(`[musik-catalog] Audio is KEPT on disk until cache limit is reached!`);
console.log(`[musik-catalog] Batch: limit=${flags.limit}, offset=${flags.offset}`);
console.log("==========================================================");

// Open SQLite DB
const db = new Database(DB_PATH);

// Read list
const rawText = await Deno.readTextFile(flags.file);
const lines = rawText
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l.length > 0);

console.log(`[musik-catalog] Loaded ${lines.length} total tracks from file.`);
const batch = lines.slice(flags.offset, flags.offset + flags.limit);

let processedCount = 0;
let skippedCount = 0;
let failedCount = 0;

for (let i = 0; i < batch.length; i++) {
  const query = batch[i];
  const itemIndex = flags.offset + i + 1;
  console.log(`\n----------------------------------------------------------`);
  console.log(`[${itemIndex}/${lines.length}] Processing: "${query}"`);

  // Parse artist and title
  let artist = "Various Artists";
  let title = query;
  if (query.includes(" - ")) {
    const parts = query.split(" - ");
    artist = parts[0].trim();
    title = parts.slice(1).join(" - ").trim();
  }

  // 1. Check if already ready in SQLite
  const existing = db.prepare(`
    SELECT t.id, f.status 
    FROM tracks t 
    LEFT JOIN features f ON f.track_id = t.id 
    WHERE t.title = ? AND t.artist = ?
  `).get(title, artist) as { id: number; status: string } | undefined;

  if (existing && existing.status === "ready") {
    console.log(`  -> Already exists and digitized in DB (Track ID: ${existing.id}). Skipping.`);
    skippedCount++;
    continue;
  }

  // 2. Download audio via yt-dlp
  console.log(`  [1/3] Downloading audio stream via yt-dlp...`);
  const downloadTemplate = path.join(DYNAMIC_DIR, "%(id)s.%(ext)s");
  const ytdlpCmd = new Deno.Command(YTDLP_PATH, {
    args: [
      "--no-playlist",
      "-f", "251/140/ba",
      "--no-warnings",
      `ytsearch1:${query}`,
      "-o", downloadTemplate,
      "--print", "filename"
    ],
    stdout: "piped",
    stderr: "piped"
  });

  const { code: dlCode, stdout: dlStdout, stderr: dlStderr } = await ytdlpCmd.output();
  if (dlCode !== 0) {
    console.error(`  [!] Download failed: ${new TextDecoder().decode(dlStderr).trim()}`);
    failedCount++;
    continue;
  }

  // Resolve downloaded file path
  const outLines = new TextDecoder().decode(dlStdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let audioFilePath = "";
  for (const line of outLines) {
    if (await Deno.stat(line).catch(() => null)) {
      audioFilePath = line;
      break;
    }
  }

  if (!audioFilePath) {
    console.error(`  [!] Could not locate downloaded audio file.`);
    failedCount++;
    continue;
  }

  const stat = await Deno.stat(audioFilePath);
  const fileSize = stat.size;
  const durationSec = 180.0; // default estimated duration

  console.log(`  [2/3] Audio file ready: ${path.basename(audioFilePath)} (${(fileSize/1024/1024).toFixed(2)} MB)`);

  // 3. Register in SQLite `tracks`
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tracks (path, title, artist, album, duration, file_size, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      title=excluded.title,
      artist=excluded.artist,
      duration=excluded.duration,
      file_size=excluded.file_size,
      updated_at=excluded.updated_at
  `).run(audioFilePath, title, artist, "VK Collection", durationSec, fileSize, now, now);

  const row = db.prepare(`SELECT id FROM tracks WHERE path = ?`).get(audioFilePath) as { id: number };
  const trackId = row.id;

  // 4. Compute 512D CLAP parameters on server
  console.log(`  [3/3] Calculating 512 parameters (CLAP) on server for Track ID ${trackId}...`);
  const embedCmd = new Deno.Command(PYTHON_PATH, {
    args: [
      EMBEDDER_PATH,
      audioFilePath,
      "--track-id", trackId.toString(),
      "--db", DB_PATH
    ],
    stdout: "piped",
    stderr: "piped"
  });

  const { code: embCode, stdout: embStdout, stderr: embStderr } = await embedCmd.output();
  const embOut = new TextDecoder().decode(embStdout).trim();
  const embErr = new TextDecoder().decode(embStderr).trim();

  if (embCode !== 0) {
    console.error(`  [!] Embedder failed: ${embErr}`);
    failedCount++;
    continue;
  }
  console.log(`  -> ${embOut}`);

  // 5. Cache Retention & LRU Enforce
  if (flags.mode === "keep") {
    const permPath = path.join(FAVORITES_DIR, path.basename(audioFilePath));
    await Deno.rename(audioFilePath, permPath);
    db.prepare(`UPDATE tracks SET path = ? WHERE id = ?`).run(permPath, trackId);
    console.log(`  -> Saved permanently to Favorites Library: ${permPath}`);
  } else {
    // Keep in dynamic cache! Only evict if cache exceeds max GB
    const stats = await getCacheStats(DYNAMIC_DIR, flags["cache-gb"]);
    console.log(`  -> Kept in cache: ${stats.totalMb.toFixed(1)} MB / ${stats.maxMb} MB (${stats.usagePercent}%)`);
    if (stats.usagePercent > 100) {
      console.log(`  [!] Cache limit reached (${stats.totalMb} MB > ${stats.maxMb} MB). Running LRU eviction...`);
      const evict = await enforceLruCache(DYNAMIC_DIR, flags["cache-gb"]);
      console.log(`  -> Evicted ${evict.evictedFiles.length} oldest unplayed files to free space.`);
    }
  }

  processedCount++;
}

console.log("\n==========================================================");
console.log(`[musik-catalog] Batch Complete!`);
console.log(`  Processed: ${processedCount}`);
console.log(`  Skipped (already ready): ${skippedCount}`);
console.log(`  Failed: ${failedCount}`);
console.log("==========================================================");

// Trigger Go player reload
console.log(`[musik-catalog] Notifying Go player at http://127.0.0.1:8787/api/reload...`);
try {
  // Try port 80 first, fallback to 8787
  let reloaded = false;
  try {
    const r = await fetch("http://127.0.0.1/api/reload", { method: "POST" });
    if (r.ok) {
      console.log(`[musik-catalog] Player reload on port 80: HTTP ${r.status}`);
      reloaded = true;
    }
  } catch {}
  if (!reloaded) {
    const r2 = await fetch("http://127.0.0.1:8787/api/reload", { method: "POST" });
    console.log(`[musik-catalog] Player reload on port 8787: HTTP ${r2.status}`);
  }
} catch (e) {
  console.log(`[musik-catalog] Note: Player reload call: ${e}`);
}

db.close();
