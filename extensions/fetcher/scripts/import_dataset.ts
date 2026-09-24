// extensions/fetcher/scripts/import_dataset.ts: High-Performance CLI Tool for Importing Datasets
import * as path from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { getDb } from "../src/db.ts";
import { insertExternal12DTracksBatch } from "../src/dataset_bridge.ts";
import { ExternalCatalogTrack, AcousticFeatures12D } from "../src/types.ts";

const flags = parseArgs(Deno.args, {
  string: ["file", "format"],
  number: ["limit", "offset", "batch-size"],
  default: {
    file: "data/spotify_tracks_114k.csv",
    format: "csv", // "text" (Artist - Title) or "csv" (Spotify 12D features)
    limit: 0, // 0 = all
    offset: 0,
    "batch-size": 5000
  }
});

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

console.log(`=======================================================`);
console.log(`[import-dataset] Importing tracks from: ${flags.file}`);
console.log(` Format: ${flags.format}`);
console.log(` Limit: ${flags.limit === 0 ? "ALL" : flags.limit}, Offset: ${flags.offset}`);
console.log(` Batch Size: ${flags["batch-size"]}`);
console.log(`=======================================================`);

const db = getDb();
const rawText = await Deno.readTextFile(flags.file);
const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

console.log(`Loaded ${lines.length} total entries from file.`);

let rowsToProcess: string[] = [];
if (flags.format === "text") {
  const sliceEnd = flags.limit === 0 ? lines.length : flags.offset + flags.limit;
  rowsToProcess = lines.slice(flags.offset, sliceEnd);
} else {
  const sliceEnd = flags.limit === 0 ? lines.length : 1 + flags.offset + flags.limit;
  rowsToProcess = lines.slice(1 + flags.offset, sliceEnd);
}

const batchSize = flags["batch-size"] || 5000;
let currentBatch: ExternalCatalogTrack[] = [];
let totalImported = 0;
const t0 = performance.now();

if (flags.format === "text") {
  for (let i = 0; i < rowsToProcess.length; i++) {
    const query = rowsToProcess[i];
    let artist = "Various Artists";
    let title = query;
    if (query.includes(" - ")) {
      const parts = query.split(" - ");
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }

    currentBatch.push({
      artist,
      title,
      duration_sec: 180,
      genre: "General",
      is_available: true,
      added_at: new Date().toISOString()
    });

    if (currentBatch.length >= batchSize) {
      totalImported += insertExternal12DTracksBatch(currentBatch, db);
      currentBatch = [];
      console.log(`[import-dataset] Progress: ${totalImported} tracks imported...`);
    }
  }
} else if (flags.format === "csv") {
  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());
  const artistIdx = header.indexOf("artists") !== -1 ? header.indexOf("artists") : header.indexOf("artist");
  const titleIdx = header.indexOf("track_name") !== -1 ? header.indexOf("track_name") : (header.indexOf("title") !== -1 ? header.indexOf("title") : header.indexOf("name"));
  const albumIdx = header.indexOf("album_name") !== -1 ? header.indexOf("album_name") : header.indexOf("album");
  const genreIdx = header.indexOf("track_genre") !== -1 ? header.indexOf("track_genre") : header.indexOf("genre");
  const danceIdx = header.indexOf("danceability");
  const energyIdx = header.indexOf("energy");
  const keyIdx = header.indexOf("key");
  const loudIdx = header.indexOf("loudness");
  const modeIdx = header.indexOf("mode");
  const speechIdx = header.indexOf("speechiness");
  const acousticIdx = header.indexOf("acousticness");
  const instIdx = header.indexOf("instrumentalness");
  const liveIdx = header.indexOf("liveness");
  const valIdx = header.indexOf("valence");
  const tempoIdx = header.indexOf("tempo");
  const durIdx = header.indexOf("duration_ms");

  for (let i = 0; i < rowsToProcess.length; i++) {
    const cols = parseCsvLine(rowsToProcess[i]);
    if (cols.length < 5) continue;

    let rawArtist = (artistIdx !== -1 && cols[artistIdx]) ? cols[artistIdx] : "Unknown";
    if (rawArtist.startsWith("[") && rawArtist.endsWith("]")) {
      rawArtist = rawArtist.slice(1, -1).replace(/^['"]+|['"]+$/g, "").replace(/['"],\s*['"]/g, ", ");
    }
    const artist = rawArtist.trim() || "Unknown";
    const title = (titleIdx !== -1 && cols[titleIdx]) ? cols[titleIdx].trim() : "Unknown";
    const album = (albumIdx !== -1 && cols[albumIdx]) ? cols[albumIdx].trim() : "";
    const genre = (genreIdx !== -1 && cols[genreIdx]) ? cols[genreIdx].trim() : "General";

    const durationMs = durIdx !== -1 ? parseFloat(cols[durIdx]) || 180000 : 180000;

    const features: AcousticFeatures12D = {
      danceability: danceIdx !== -1 ? parseFloat(cols[danceIdx]) || 0.5 : 0.5,
      energy: energyIdx !== -1 ? parseFloat(cols[energyIdx]) || 0.5 : 0.5,
      key: keyIdx !== -1 ? parseInt(cols[keyIdx], 10) || 0 : 0,
      loudness: loudIdx !== -1 ? parseFloat(cols[loudIdx]) || -8 : -8,
      mode: modeIdx !== -1 ? parseInt(cols[modeIdx], 10) || 1 : 1,
      speechiness: speechIdx !== -1 ? parseFloat(cols[speechIdx]) || 0.05 : 0.05,
      acousticness: acousticIdx !== -1 ? parseFloat(cols[acousticIdx]) || 0.2 : 0.2,
      instrumentalness: instIdx !== -1 ? parseFloat(cols[instIdx]) || 0 : 0,
      liveness: liveIdx !== -1 ? parseFloat(cols[liveIdx]) || 0.1 : 0.1,
      valence: valIdx !== -1 ? parseFloat(cols[valIdx]) || 0.5 : 0.5,
      tempo: tempoIdx !== -1 ? parseFloat(cols[tempoIdx]) || 120 : 120,
      duration_sec: Math.round(durationMs / 1000)
    };

    currentBatch.push({
      artist,
      title,
      album,
      duration_sec: Math.round(durationMs / 1000),
      genre,
      features,
      is_available: true,
      added_at: new Date().toISOString()
    });

    if (currentBatch.length >= batchSize) {
      totalImported += insertExternal12DTracksBatch(currentBatch, db);
      currentBatch = [];
      console.log(`[import-dataset] Progress: ${totalImported} tracks imported...`);
    }
  }
}

if (currentBatch.length > 0) {
  totalImported += insertExternal12DTracksBatch(currentBatch, db);
}

const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);
console.log(`=======================================================`);
console.log(`[import-dataset] Finished in ${elapsedSec}s!`);
console.log(`Successfully registered ${totalImported} tracks into external_catalog.`);
console.log(`=======================================================`);
Deno.exit(0);
