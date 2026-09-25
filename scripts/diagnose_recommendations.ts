import { getDb } from "../extensions/fetcher/src/db.ts";
import { find12DCandidates } from "../extensions/fetcher/src/dataset_bridge.ts";

const db = getDb();

console.log("=== RECENT 15 ACTIONS ===");
const history = db.prepare(`
  SELECT h.action, t.artist, t.title, h.ts 
  FROM listening_history h 
  JOIN tracks t ON t.id = h.track_id 
  ORDER BY h.ts DESC 
  LIMIT 15
`).all();
console.table(history);

console.log("\n=== FAVORITES COUNT & SAMPLES ===");
const favCount = db.prepare("SELECT count(*) as c FROM favorites").get();
console.log("Favorites count:", favCount);
const favs = db.prepare(`
  SELECT t.id, t.artist, t.title 
  FROM favorites f 
  JOIN tracks t ON t.id = f.track_id 
  ORDER BY f.created_at DESC 
  LIMIT 10
`).all();
console.table(favs);

console.log("\n=== WHAT DID RADIO QUEUE ACTUALLY SUGGEST RECENTLY? ===");
const recentSkips = db.prepare(`
  SELECT t.id, t.artist, t.title, h.action, h.ts
  FROM listening_history h
  JOIN tracks t ON t.id = h.track_id
  WHERE h.action IN ('skip', 'dislike')
  ORDER BY h.ts DESC
  LIMIT 10
`).all();
console.table(recentSkips);

console.log("\n=== GENRE DISTRIBUTION IN EXTERNAL_CATALOG ===");
const genres = db.prepare(`
  SELECT genre, count(*) as count 
  FROM external_catalog 
  GROUP BY genre 
  ORDER BY count DESC 
  LIMIT 15
`).all();
console.table(genres);

console.log("\n=== CHECKING SEED & 12D CANDIDATES ===");
// Run find12DCandidates with default seed
const testSeed = {
  danceability: 0.6,
  energy: 0.7,
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
const hits = find12DCandidates(testSeed, 10, new Set(), db);
console.log("Hits from find12DCandidates:");
console.table(hits);
