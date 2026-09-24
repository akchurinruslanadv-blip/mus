// extensions/fetcher/tests/lru_test.ts: Automated Tests for LRU & Pinning Protection
import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { Database } from "@db/sqlite";
import { initSchema, pinTrack, unpinTrack, isTrackPinned } from "../src/db.ts";

Deno.test("LRU: Pinning tracks grants permanent protection", () => {
  const db = new Database(":memory:");
  db.prepare(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY, path TEXT, title TEXT, artist TEXT, duration REAL, created_at TEXT, updated_at TEXT
    )
  `).run();
  initSchema(db);

  // Add sample track
  db.prepare(`
    INSERT INTO tracks (id, path, title, artist, duration, created_at, updated_at)
    VALUES (101, 'C:\\test\\audio.webm', 'Test Song', 'Test Artist', 180, '2026-01-01', '2026-01-01')
  `).run();

  assertEquals(isTrackPinned(101, db), false, "Track should initially not be pinned");

  // Pin track (💾 Сохранить навсегда)
  pinTrack(101, db);
  assertEquals(isTrackPinned(101, db), true, "Track should be marked as pinned");

  // Unpin track
  unpinTrack(101, db);
  assertEquals(isTrackPinned(101, db), false, "Track should be unpinned");

  db.close();
});
