// extensions/fetcher/tests/dataset_bridge_test.ts: Tests for 12D Distance & Blending
import { assertEquals, assert } from "@std/assert";
import { Database } from "@db/sqlite";
import { initSchema } from "../src/db.ts";
import { compute12DDistance, find12DCandidates, insertExternal12DTrack, getColdStartSeeds } from "../src/dataset_bridge.ts";
import { AcousticFeatures12D } from "../src/types.ts";

Deno.test("DatasetBridge: 12D distance reflects acoustic similarity", () => {
  const rockA: AcousticFeatures12D = {
    danceability: 0.5,
    energy: 0.85,
    key: 2,
    loudness: -5,
    mode: 1,
    speechiness: 0.05,
    acousticness: 0.02,
    instrumentalness: 0.01,
    liveness: 0.1,
    valence: 0.6,
    tempo: 125
  };

  const rockB: AcousticFeatures12D = {
    danceability: 0.52,
    energy: 0.82,
    key: 2,
    loudness: -6,
    mode: 1,
    speechiness: 0.04,
    acousticness: 0.05,
    instrumentalness: 0.02,
    liveness: 0.12,
    valence: 0.58,
    tempo: 122
  };

  const ambientC: AcousticFeatures12D = {
    danceability: 0.15,
    energy: 0.15,
    key: 5,
    loudness: -22,
    mode: 0,
    speechiness: 0.03,
    acousticness: 0.95,
    instrumentalness: 0.85,
    liveness: 0.08,
    valence: 0.12,
    tempo: 65
  };

  const distRock = compute12DDistance(rockA, rockB);
  const distAmbient = compute12DDistance(rockA, ambientC);

  assert(distRock < distAmbient, "Rock tracks should be significantly closer than Ambient track in 12D space");
});

Deno.test("DatasetBridge: Cold-start seeds and candidate search", () => {
  const db = new Database(":memory:");
  initSchema(db);

  insertExternal12DTrack({
    artist: "Nirvana",
    title: "Smells Like Teen Spirit",
    genre: "Grunge",
    duration_sec: 301,
    is_available: true,
    added_at: "2026-01-01",
    features: {
      danceability: 0.5,
      energy: 0.9,
      key: 1,
      loudness: -5,
      mode: 1,
      speechiness: 0.05,
      acousticness: 0.0,
      instrumentalness: 0.0,
      liveness: 0.1,
      valence: 0.7,
      tempo: 117
    }
  }, db);

  insertExternal12DTrack({
    artist: "The Beatles",
    title: "Yesterday",
    genre: "Acoustic",
    duration_sec: 125,
    is_available: true,
    added_at: "2026-01-01",
    features: {
      danceability: 0.33,
      energy: 0.18,
      key: 5,
      loudness: -12,
      mode: 1,
      speechiness: 0.03,
      acousticness: 0.87,
      instrumentalness: 0.0,
      liveness: 0.09,
      valence: 0.31,
      tempo: 96
    }
  }, db);

  // Cold start seeds
  const seeds = getColdStartSeeds(2, db);
  assertEquals(seeds.length, 2, "Should return 2 cold-start seeds");

  // Candidate search with rock seed
  const candidates = find12DCandidates({
    danceability: 0.48,
    energy: 0.88,
    key: 1,
    loudness: -5,
    mode: 1,
    speechiness: 0.04,
    acousticness: 0.01,
    instrumentalness: 0.0,
    liveness: 0.1,
    valence: 0.65,
    tempo: 120
  }, 1, new Set(), db);

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].artist, "Nirvana", "Candidate search should prioritize closest acoustic match");

  // Bias shift test: Steering towards acousticness should flip candidate to The Beatles
  const biasedCandidates = find12DCandidates({
    danceability: 0.45,
    energy: 0.60,
    key: 3,
    loudness: -8,
    mode: 1,
    speechiness: 0.04,
    acousticness: 0.20,
    instrumentalness: 0.0,
    liveness: 0.1,
    valence: 0.50,
    tempo: 105
  }, 1, new Set(), db, {
    energy: -0.4,
    acousticness: +0.6
  });

  assertEquals(biasedCandidates[0].artist, "The Beatles", "Acoustic bias should steer recommendation towards acoustic tracks");

  db.close();
});
