// extensions/fetcher/tests/ingestion_queue_test.ts: Ingestion Queue Test Suite
import { assertEquals, assertNotEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  initSchema,
  addIngestionTasks,
  getNextPendingIngestionTask,
  updateIngestionTaskStatus,
  getIngestionStatusSummary,
  clearIngestionQueue,
  addToFavorites,
  isFavorite,
  pinTrack,
  isTrackPinned
} from "../src/db.ts";

Deno.test("Ingestion Queue - Add and process tasks with independent options", () => {
  // Use in-memory SQLite database
  const db = new Database(":memory:");
  initSchema(db);

  // Add dummy tracks table and features table for foreign key tests
  db.prepare(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration REAL,
      file_size INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS features (
      track_id INTEGER PRIMARY KEY,
      embedding BLOB,
      status TEXT DEFAULT 'pending'
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS favorites (
      track_id INTEGER PRIMARY KEY,
      added_at TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  // 1. Add tasks with different options
  const tasks = [
    {
      artist: "Daft Punk",
      title: "One More Time",
      addToFavorites: true,
      pinForever: false,
      autoEmbed512: true
    },
    {
      artist: "The Weeknd",
      title: "Blinding Lights",
      addToFavorites: false,
      pinForever: true,
      autoEmbed512: true
    },
    {
      artist: "Radiohead",
      title: "Karma Police",
      addToFavorites: false,
      pinForever: false,
      autoEmbed512: false
    }
  ];

  const added = addIngestionTasks(tasks, db);
  assertEquals(added, 3);

  const summary = getIngestionStatusSummary(db);
  assertEquals(summary.total, 3);
  assertEquals(summary.pending, 3);
  assertEquals(summary.ready, 0);

  // 2. Fetch first task
  const t1 = getNextPendingIngestionTask(db);
  assertNotEquals(t1, null);
  assertEquals(t1?.artist, "Daft Punk");
  assertEquals(t1?.addToFavorites, true);
  assertEquals(t1?.pinForever, false);
  assertEquals(t1?.autoEmbed512, true);

  // Update t1 to ready
  updateIngestionTaskStatus(t1!.id, "ready", undefined, 101, db);

  // 3. Verify status summary update
  const summary2 = getIngestionStatusSummary(db);
  assertEquals(summary2.pending, 2);
  assertEquals(summary2.ready, 1);

  // 4. Test Favorites and Pinning helpers
  db.prepare(`INSERT INTO tracks (id, path, title, artist) VALUES (101, 'dynamic/daft.opus', 'One More Time', 'Daft Punk')`).run();
  
  addToFavorites(101, db);
  assertEquals(isFavorite(101, db), true);

  pinTrack(101, db);
  assertEquals(isTrackPinned(101, db), true);

  // 5. Clear queue
  clearIngestionQueue(db);
  const summaryEmpty = getIngestionStatusSummary(db);
  assertEquals(summaryEmpty.total, 0);

  db.close();
});
