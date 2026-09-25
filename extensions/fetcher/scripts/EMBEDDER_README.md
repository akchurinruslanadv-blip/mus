# Standalone 512D CLAP Embedder Daemon for `musik`

A high-performance, lightweight audio feature extractor microservice for the `musik` ecosystem. Computes 512-dimensional normalized embedding vectors using `laion/larger_clap_music_and_speech` (HTS-AT audio transformer) and writes directly to SQLite or returns JSON via REST API.

---

## Key Highlights

1. **Batched 3-Window Parallel Inference:**
   - Extracts three 30-second windows (intro, middle/climax, outro = 90s total audio) for 100% latent space fidelity.
   - All 3 audio slices are stacked and evaluated **simultaneously in a single parallel PyTorch forward pass** (2x speedup over sequential loops).
2. **Sub-second FFmpeg Keyframe Seeking:**
   - `-ss` input seek before `-i` avoids decoding unneeded frames.
   - `-vn -sn -dn` discards video streams, cover art, and subtitles.
   - Direct memory streaming via `pcm_f32le` on `pipe:1` (zero disk I/O, no temporary `.wav` files).
3. **Ultra-Low Memory Mode (Fits in 1 GB RAM):**
   - Configurable CPU thread limit (`--threads 1` or `TORCH_THREADS=1`) prevents CPU core contention.
   - Explicit garbage collection (`gc.collect()`) releases intermediate activation tensors after each request.
   - Optional Dynamic INT8 quantization (`--quantize-int8` or `EMBEDDER_QUANTIZE=1`) reduces model memory footprint to **~280 MB**.

---

## REST API Specification

Default port: `:8790`

### 1. Health & Status Check
`GET /health` or `GET /status`

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "service": "musik-clap-embedder",
  "model": "laion/larger_clap_music_and_speech",
  "dim": 512,
  "quantized": false,
  "threads": 2
}
```

### 2. Extract Embedding
`POST /embed`

**Request Body:**
```json
{
  "audio_path": "C:\\music\\track.mp3",
  "track_id": 42,
  "db_path": "C:\\data\\musik.db",
  "duration": 215.5
}
```

* `audio_path` *(string, required)*: Path to local audio file (`.mp3`, `.webm`, `.m4a`, `.opus`, `.flac`).
* `track_id` *(integer, optional)*: If supplied, the 512D vector is immediately stored in `features.embedding` (`BLOB`, 2048 bytes) in the target SQLite DB.
* `db_path` *(string, optional)*: Custom SQLite database path.
* `duration` *(float, optional)*: Pre-known audio duration in seconds (skips FFmpeg probe).

**Response (`200 OK`):**
```json
{
  "ok": true,
  "track_id": 42,
  "dim": 512,
  "norm": 1.0000
}
```

---

## CLI Usage

### Run as Persistent HTTP Daemon:
```bash
python embedder.py --server --port 8790 --threads 2
```

### Run with Ultra-Low RAM Mode (1 GB VPS):
```bash
python embedder.py --server --port 8790 --threads 1 --quantize-int8
```

### Single File Ad-hoc Extraction:
```bash
python embedder.py /path/to/song.opus --track-id 123 --db /path/to/musik.db
```
