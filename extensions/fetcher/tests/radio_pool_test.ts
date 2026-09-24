// extensions/fetcher/tests/radio_pool_test.ts: Radio Candidate Pool Test Suite
import { assertEquals, assertNotEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { initSchema } from "../src/db.ts";
import { find12DCandidates, insertExternal12DTrack } from "../src/dataset_bridge.ts";
import { AcousticFeatures12D } from "../src/types.ts";

Deno.test("Radio Pool - 12D candidate scoring & deduplication", () => {
  const db = new Database(":memory:");
  initSchema(db);

  const energeticPop: AcousticFeatures12D = {
    danceability: 0.85,
    energy: 0.90,
    key: 1,
    loudness: -5.0,
    mode: 1,
    speechiness: 0.08,
    acousticness: 0.05,
    instrumentalness: 0.0,
    liveness: 0.15,
    valence: 0.80,
    tempo: 128
  };

  const slowAcoustic: AcousticFeatures12D = {
    danceability: 0.30,
    energy: 0.20,
    key: 5,
    loudness: -18.0,
    mode: 0,
    speechiness: 0.03,
    acousticness: 0.95,
    instrumentalness: 0.5,
    liveness: 0.10,
    valence: 0.25,
    tempo: 75
  };

  // Insert test catalog items
  insertExternal12DTrack({
    artist: "Dua Lipa",
    title: "Don't Start Now",
    duration_sec: 183,
    features: energeticPop,
    is_available: true,
    added_at: new Date().toISOString()
  }, db);

  insertExternal12DTrack({
    artist: "Norah Jones",
    title: "Don't Know Why",
    duration_sec: 185,
    features: slowAcoustic,
    is_available: true,
    added_at: new Date().toISOString()
  }, db);

  // 1. Search with Energetic Pop Seed
  const popSeed: AcousticFeatures12D = {
    danceability: 0.80,
    energy: 0.85,
    key: 1,
    loudness: -6.0,
    mode: 1,
    speechiness: 0.05,
    acousticness: 0.1,
    instrumentalness: 0,
    liveness: 0.1,
    valence: 0.75,
    tempo: 125
  };

  const hits = find12DCandidates(popSeed, 5, new Set(), db);
  assertEquals(hits.length, 2);
  assertEquals(hits[0].artist, "Dua Lipa");
  assertEquals(hits[0].similarity > hits[1].similarity, true);

  // 2. Test Exclusion set (deduplication)
  const excludeSet = new Set(["dua lipa - don't start now"]);
  const hitsExcluded = find12DCandidates(popSeed, 5, excludeSet, db);
  assertEquals(hitsExcluded.length, 1);
  assertEquals(hitsExcluded[0].artist, "Norah Jones");

  db.close();
});
