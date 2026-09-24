import { Database } from "@db/sqlite";
import * as path from "@std/path";

const projectRoot = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const dbPath = path.resolve(projectRoot, "data", "db", "musik.db");
const db = new Database(dbPath);

console.log("=== FILTERING EXTERNAL CATALOG (EXCLUDING PODCASTS & SPOKEN WORD) ===");

// 1. By duration or genre
const sql1 = `
  UPDATE external_catalog
  SET is_available = 0
  WHERE is_available = 1 AND (
    duration_sec > 600 
    OR duration_sec < 45 
    OR LOWER(genre) LIKE '%podcast%' 
    OR LOWER(genre) LIKE '%audiobook%' 
    OR LOWER(genre) LIKE '%comedy%' 
    OR LOWER(genre) LIKE '%spoken%' 
    OR LOWER(title) LIKE '%podcast%' 
    OR LOWER(artist) LIKE '%podcast%' 
    OR LOWER(title) LIKE '%audiobook%' 
    OR LOWER(artist) LIKE '%audiobook%' 
    OR LOWER(title) LIKE '%interview%'
  )
`;
const res1 = db.prepare(sql1).run();
console.log("Marked unavailable by duration/genre/title:", typeof res1 === "number" ? res1 : (res1 as any)?.changes);

// 2. By high speechiness (> 0.38)
const rows = db.prepare(`
  SELECT id, features_json FROM external_catalog WHERE is_available = 1 AND features_json IS NOT NULL
`).all() as any[];

let highSpeechCount = 0;
const toDisable: number[] = [];

for (const r of rows) {
  try {
    const f = JSON.parse(r.features_json);
    if (f.speechiness && f.speechiness > 0.38) {
      toDisable.push(r.id);
      highSpeechCount++;
    }
  } catch {}
}

if (toDisable.length > 0) {
  db.transaction(() => {
    const stmt = db.prepare(`UPDATE external_catalog SET is_available = 0 WHERE id = ?`);
    for (const id of toDisable) {
      stmt.run(id);
    }
  });
}

console.log(`Marked unavailable due to high speechiness (>0.38): ${highSpeechCount} tracks.`);

const availableCount = (db.prepare(`SELECT count(*) as c FROM external_catalog WHERE is_available = 1`).get() as any).c;
console.log(`Remaining clean music tracks in catalog: ${availableCount}`);

db.close();
