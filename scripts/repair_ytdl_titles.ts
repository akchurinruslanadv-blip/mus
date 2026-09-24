// scripts/repair_ytdl_titles.ts: Restore clean artist & title for tracks with YouTube IDs as titles
import { Database } from "@db/sqlite";
import * as path from "@std/path";

const projectRoot = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const dbPath = path.resolve(projectRoot, "data", "db", "musik.db");

console.log("==================================================");
console.log(" 🛠️ Repairing YouTube ID titles in SQLite...");
console.log(` Database: ${dbPath}`);
console.log("==================================================");

const db = new Database(dbPath);
try {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 15000;");
} catch {}

const tracks = db.prepare(`
  SELECT 
    t.id, 
    t.artist, 
    t.title,
    t.path,
    iq.artist as iq_artist,
    iq.title as iq_title
  FROM tracks t
  LEFT JOIN ingestion_queue iq ON t.id = iq.track_id
  WHERE length(t.title) = 11
`).all() as any[];

console.log(`Found ${tracks.length} tracks with 11-char YouTube ID titles.\n`);

const updateStmt = db.prepare("UPDATE tracks SET artist = ?, title = ?, updated_at = ? WHERE id = ?");

function cleanTag(str: string): string {
  return (str || "")
    .replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyrics|Official\s*Audio|Official|Lyric\s*Video|HD|HQ|MV|Visualizer)[\)\]]/gi, "")
    .replace(/[\uFFFD\u0080-\u009F]/g, "")
    .trim();
}

let fixedFromIq = 0;
let fixedFromArtistSplit = 0;
let skipped = 0;

const now = new Date().toISOString();

for (const t of tracks) {
  let cleanArtist = "";
  let cleanTitle = "";

  // 1. First priority: original clean artist & title from ingestion_queue
  if (t.iq_artist && t.iq_title) {
    cleanArtist = cleanTag(t.iq_artist);
    cleanTitle = cleanTag(t.iq_title);
    if (cleanArtist && cleanTitle) {
      updateStmt.run(cleanArtist, cleanTitle, now, t.id);
      fixedFromIq++;
      continue;
    }
  }

  // 2. Second priority: parse from artist field if it contains " - "
  if (t.artist && t.artist.includes(" - ")) {
    const parts = t.artist.split(" - ");
    cleanArtist = cleanTag(parts[0]);
    cleanTitle = cleanTag(parts.slice(1).join(" - "));
    if (cleanArtist && cleanTitle) {
      updateStmt.run(cleanArtist, cleanTitle, now, t.id);
      fixedFromArtistSplit++;
      continue;
    }
  }

  // 3. Fallback: if artist doesn't have " - "
  if (t.artist && t.artist.trim()) {
    cleanArtist = cleanTag(t.artist);
    cleanTitle = cleanArtist;
    updateStmt.run(cleanArtist, cleanTitle, now, t.id);
    fixedFromArtistSplit++;
  } else {
    skipped++;
  }
}

console.log("==================================================");
console.log(` 🎉 Title repair completed!`);
console.log(` Restored from Ingestion Queue: ${fixedFromIq}`);
console.log(` Restored from Artist split:   ${fixedFromArtistSplit}`);
console.log(` Skipped:                      ${skipped}`);
console.log("==================================================");

// Notify Go Core to reload metadata
try {
  const res = await fetch("http://127.0.0.1:8786/api/reload", { method: "POST" });
  console.log(`Go core reload response: ${res.status}`);
} catch {
  console.log("Go core reload ping sent.");
}

db.close();
