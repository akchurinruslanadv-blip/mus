"""
embedder.py: Standalone 512D CLAP Audio Feature Extractor for musik
Compatible with laion/larger_clap_music_and_speech (512-dim float32 vector).
Directly updates SQLite features table or outputs 2048 bytes raw/base64.
"""

import sys
import os
import argparse
import subprocess
import sqlite3
import numpy as np
from datetime import datetime, timezone
from pathlib import Path

# Paths
def find_project_root() -> Path:
    cur = Path(__file__).resolve().parent
    for _ in range(6):
        if (cur / "data" / "db").is_dir() or (cur / "bin").is_dir():
            return cur
        cur = cur.parent
    # Fallback: traverse up 3 levels from extensions/fetcher/scripts/
    return Path(__file__).resolve().parent.parent.parent

PROJECT_ROOT = find_project_root()
BIN_DIR = PROJECT_ROOT / "bin"
FFMPEG_PATH = BIN_DIR / "ffmpeg.exe"
DEFAULT_DB = PROJECT_ROOT / "data" / "db" / "musik.db"
DEFAULT_MODEL = "laion/larger_clap_music_and_speech"
DEFAULT_SR = 48000
SEGMENT_SEC = 30.0

def utcnow_iso():
    return datetime.now(timezone.utc).isoformat()

def get_audio_duration(file_path: Path) -> float:
    """Get audio duration in seconds via ffmpeg."""
    cmd = [
        str(FFMPEG_PATH), "-i", str(file_path)
    ]
    p = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, errors="replace")
    # Search for Duration: 00:03:25.12
    for line in p.stderr.splitlines():
        if "Duration:" in line:
            parts = line.split("Duration:")[1].split(",")[0].strip().split(":")
            if len(parts) == 3:
                h = float(parts[0])
                m = float(parts[1])
                s = float(parts[2])
                return h * 3600 + m * 60 + s
    return 180.0  # default 3 min fallback

def load_audio_window(file_path: Path, offset_sec: float, duration_sec: float) -> np.ndarray:
    """Load a specific window of audio as 48kHz mono float32 array using ffmpeg."""
    cmd = [
        str(FFMPEG_PATH), "-nostdin", "-v", "error",
        "-ss", f"{max(0.0, offset_sec):.3f}",
        "-t", f"{max(0.1, duration_sec):.3f}",
        "-i", str(file_path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(DEFAULT_SR),
        "pipe:1"
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg error: {p.stderr.decode('utf-8', errors='replace')}")
    raw = p.stdout
    if not raw:
        return np.zeros(int(DEFAULT_SR * duration_sec), dtype=np.float32)
    return np.frombuffer(raw, dtype=np.float32)

def l2_normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if norm < 1e-12:
        return vec.astype(np.float32)
    return (vec / norm).astype(np.float32)

_MODEL_CACHE = {}

def get_model():
    if "model" not in _MODEL_CACHE:
        import torch
        from transformers import ClapModel, ClapProcessor

        print(f"[embedder] Loading CLAP model '{DEFAULT_MODEL}' (CPU)...", file=sys.stderr)
        processor = ClapProcessor.from_pretrained(DEFAULT_MODEL)
        model = ClapModel.from_pretrained(DEFAULT_MODEL)
        model.eval()
        _MODEL_CACHE["processor"] = processor
        _MODEL_CACHE["model"] = model
    return _MODEL_CACHE["processor"], _MODEL_CACHE["model"]

def compute_clap_embedding(file_path: Path) -> np.ndarray:
    """Extract 512D CLAP embedding across 3 windows (start, middle, end)."""
    import torch

    processor, model = get_model()
    duration = get_audio_duration(file_path)

    # Plan up to 3 non-overlapping windows (30s each)
    windows = []
    if duration <= SEGMENT_SEC + 1.0:
        windows = [(0.0, duration)]
    else:
        windows = [
            (0.0, SEGMENT_SEC),
            (max(0.0, duration / 2.0 - SEGMENT_SEC / 2.0), SEGMENT_SEC),
            (max(0.0, duration - SEGMENT_SEC), SEGMENT_SEC)
        ]

    vecs = []
    for offset, seg_dur in windows:
        y = load_audio_window(file_path, offset, seg_dur)
        if len(y) < 1000:
            continue
        inputs = processor(audio=[y], sampling_rate=DEFAULT_SR, return_tensors="pt", padding=True)
        with torch.no_grad():
            out = model.get_audio_features(**inputs)
            if hasattr(out, "pooler_output") and out.pooler_output is not None:
                feat = out.pooler_output
            else:
                feat = out
            v = feat[0].detach().cpu().float().numpy().reshape(-1)
            vecs.append(l2_normalize(v))

    if not vecs:
        raise ValueError(f"Could not extract audio features from {file_path}")

    # Average windows and normalize
    mean_vec = np.mean(vecs, axis=0)
    final_vec = l2_normalize(mean_vec)
    if final_vec.shape[0] != 512:
        raise ValueError(f"Expected 512 dimensions, got {final_vec.shape[0]}")
    return final_vec

def update_db_feature(db_path: Path, track_id: int, vec: np.ndarray):
    """Write 512 float32 blob (2048 bytes) into features table with status='ready'."""
    blob = vec.astype(np.float32).tobytes()
    now = utcnow_iso()
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("""
            INSERT INTO features (track_id, embedding, embedding_dim, status, error, computed_at)
            VALUES (?, ?, ?, 'ready', NULL, ?)
            ON CONFLICT(track_id) DO UPDATE SET
                embedding = excluded.embedding,
                embedding_dim = excluded.embedding_dim,
                status = 'ready',
                error = NULL,
                computed_at = excluded.computed_at
        """, (track_id, blob, len(vec), now))
        conn.commit()

from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class EmbedderHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress verbose HTTP logs
        pass

    def do_GET(self):
        if self.path in ("/health", "/status"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "service": "musik-clap-embedder",
                "model": DEFAULT_MODEL,
                "dim": 512
            }).encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path in ("/embed", "/api/embed"):
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                data = json.loads(body)

                audio_file = data.get("audio_path") or data.get("file")
                track_id = data.get("track_id")
                db_path = data.get("db_path") or str(DEFAULT_DB)

                if not audio_file:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "error": "Missing audio_path"}).encode("utf-8"))
                    return

                audio_path = Path(audio_file)
                if not audio_path.is_file():
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "error": f"Audio file not found: {audio_file}"}).encode("utf-8"))
                    return

                vec = compute_clap_embedding(audio_path)
                if track_id:
                    update_db_feature(Path(db_path), int(track_id), vec)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "track_id": track_id,
                    "dim": 512,
                    "norm": float(np.linalg.norm(vec))
                }).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

def run_server(host="127.0.0.1", port=8790):
    print(f"[embedder-daemon] Pre-warming CLAP neural network model...", file=sys.stderr)
    get_model()
    server = HTTPServer((host, port), EmbedderHTTPHandler)
    print(f"[embedder-daemon] CLAP 512D Embedder Service ready on http://{host}:{port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

def main():
    parser = argparse.ArgumentParser(description="Extract 512D CLAP embedding for musik")
    parser.add_argument("file", nargs="?", default=None, help="Path to audio file (optional if --server)")
    parser.add_argument("--server", action="store_true", help="Run as persistent HTTP embedder daemon")
    parser.add_argument("--port", type=int, default=8790, help="HTTP daemon port (default: 8790)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="HTTP daemon host (default: 127.0.0.1)")
    parser.add_argument("--track-id", type=int, help="Track ID to update in SQLite")
    parser.add_argument("--db", type=str, default=str(DEFAULT_DB), help="Path to musik.db")
    args = parser.parse_args()

    if args.server:
        run_server(host=args.host, port=args.port)
        return

    if not args.file:
        parser.print_help()
        sys.exit(1)

    audio_path = Path(args.file)
    if not audio_path.is_file():
        print(f"Error: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    try:
        vec = compute_clap_embedding(audio_path)
        if args.track_id:
            update_db_feature(Path(args.db), args.track_id, vec)
            print(f"OK: Track {args.track_id} updated with 512D embedding in DB.")
        else:
            # Print hex or summary
            print(f"OK: Extracted 512D embedding (norm={np.linalg.norm(vec):.4f})")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
