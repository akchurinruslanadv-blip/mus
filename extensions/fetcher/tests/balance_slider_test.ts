import { assertEquals, assert } from "@std/assert";
import { Database } from "@db/sqlite";
import { getFavoriteCandidates, get512DCandidates } from "../src/db.ts";

Deno.test("Radio Balance: getFavoriteCandidates retrieves favorite tracks with proper scoring", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, artist TEXT, title TEXT, album TEXT, path TEXT, duration REAL, is_active INTEGER);
    CREATE TABLE favorites (track_id INTEGER PRIMARY KEY, added_at TEXT, position INTEGER);
    CREATE TABLE features (track_id INTEGER, embedding BLOB, status TEXT);
  `);

  db.exec(`
    INSERT INTO tracks VALUES (1, 'Queen', 'Bohemian Rhapsody', 'A Night at the Opera', '/path/1', 354, 1);
    INSERT INTO tracks VALUES (2, 'The Beatles', 'Yesterday', 'Help!', '/path/2', 125, 1);
    INSERT INTO tracks VALUES (3, 'Daft Punk', 'Get Lucky', 'RAM', '/path/3', 248, 1);
    INSERT INTO favorites VALUES (1, '2026-01-01', 0);
    INSERT INTO favorites VALUES (2, '2026-01-01', 1);
  `);

  // Track 1 and 2 are favorites. Track 3 is not.
  const favs = getFavoriteCandidates([], 5, db);
  assertEquals(favs.length, 2);
  assertEquals(favs.some(f => f.track_id === 1), true);
  assertEquals(favs.some(f => f.track_id === 2), true);
  assertEquals(favs.some(f => f.track_id === 3), false);

  // Excluding track 1 returns only track 2
  const excluded = getFavoriteCandidates([1], 5, db);
  assertEquals(excluded.length, 1);
  assertEquals(excluded[0].track_id, 2);

  db.close();
});
