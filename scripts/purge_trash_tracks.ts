import { Database } from "@db/sqlite";
import * as path from "@std/path";

const projectRoot = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const dbPath = path.resolve(projectRoot, "data", "db", "musik.db");
const db = new Database(dbPath);

console.log("=== SCANNING FOR TRASH / NON-MUSIC TRACKS ===");

// 1. Tracks with extreme duration (>720s or <40s)
// 2. Tracks with podcast/audiobook/interview keywords in title or artist
const allTracks = db.prepare(`SELECT id, artist, title, duration, path FROM tracks`).all() as any[];

const badKeywords = [
  "audiobook", "аудиокнига", "podcast", "подкаст", "читает", "интервью", "interview",
  "стендап", "stand up", "полная версия", "книга", "шрек", "shrek"
];

const toPurge: any[] = [];

for (const t of allTracks) {
  const dur = t.duration || 0;
  const full = `${t.artist} ${t.title}`.toLowerCase();
  
  let reason = "";
  if (dur > 720) {
    reason = `extreme duration (${Math.round(dur)}s > 720s)`;
  } else if (dur < 40) {
    reason = `too short (${Math.round(dur)}s < 40s)`;
  } else if (badKeywords.some(kw => full.includes(kw))) {
    reason = `suspicious keyword in title/artist`;
  }

  if (reason) {
    toPurge.push({ ...t, reason });
  }
}

console.log(`Found ${toPurge.length} non-music / trash tracks to purge:`);
for (const p of toPurge) {
  console.log(`  [#${p.id}] ${p.artist} - ${p.title} (${Math.round(p.duration)}s) -> Reason: ${p.reason}`);
}

// Perform cleanup
let filesDeleted = 0;
db.transaction(() => {
  for (const p of toPurge) {
    // Delete file if in dynamic
    if (p.path) {
      try {
        Deno.removeSync(p.path);
        filesDeleted++;
      } catch {}
    }
    // Delete from features, favorites, playlist_tracks, listening_history, pinned_tracks, tracks
    db.prepare(`DELETE FROM features WHERE track_id = ?`).run(p.id);
    db.prepare(`DELETE FROM favorites WHERE track_id = ?`).run(p.id);
    db.prepare(`DELETE FROM playlist_tracks WHERE track_id = ?`).run(p.id);
    db.prepare(`DELETE FROM listening_history WHERE track_id = ?`).run(p.id);
    db.prepare(`DELETE FROM pinned_tracks WHERE track_id = ?`).run(p.id);
    db.prepare(`DELETE FROM tracks WHERE id = ?`).run(p.id);
  }
  
  // Also clean ingestion_queue for audiobooks/podcasts
  const qRes = db.prepare(`
    UPDATE ingestion_queue 
    SET status = 'rejected', error = 'Filtered out: podcast / spoken-word / non-music'
    WHERE status != 'ready' AND (
      LOWER(artist) LIKE '%audiobook%' OR LOWER(title) LIKE '%audiobook%' OR
      LOWER(artist) LIKE '%аудиокнига%' OR LOWER(title) LIKE '%аудиокнига%' OR
      LOWER(artist) LIKE '%подкаст%' OR LOWER(title) LIKE '%подкаст%' OR
      LOWER(artist) LIKE '%podcast%' OR LOWER(title) LIKE '%podcast%' OR
      LOWER(artist) LIKE '%интервью%' OR LOWER(title) LIKE '%интервью%' OR
      LOWER(artist) LIKE '%interview%' OR LOWER(title) LIKE '%interview%' OR
      LOWER(artist) LIKE '%читает%' OR LOWER(title) LIKE '%читает%'
    )
  `).run();
  console.log(`Rejected ${typeof qRes === 'number' ? qRes : (qRes as any)?.changes || 0} non-music queue items.`);
});

console.log(`Successfully purged ${toPurge.length} tracks from DB and deleted ${filesDeleted} audio files.`);

db.close();
