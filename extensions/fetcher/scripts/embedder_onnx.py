"""
embedder_onnx.py: Ultra-Lightweight 512D Audio Embedder for musik
Optimized for 1 vCPU / 1 GB RAM / 5 GB Disk VPS deployments.
Uses onnxruntime (~35 MB disk, ~80 MB RAM) instead of heavyweight PyTorch (2.2 GB).
Provides identical HTTP daemon API on port 8790 and CLI mode.
"""

import sys
import os
import json
import sqlite3
import argparse
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import numpy as np

def find_project_root() -> Path:
    cur = Path(__file__).resolve().parent
    for _ in range(6):
        if (cur / "data" / "db").is_dir() or (cur / "bin").is_dir():
            return cur
        cur = cur.parent
    return Path(__file__).resolve().parent.parent.parent

PROJECT_ROOT = find_project_root()
BIN_DIR = PROJECT_ROOT / "bin"
FFMPEG_PATH = BIN_DIR / "ffmpeg.exe" if sys.platform == "win32" else Path(os.environ.get("FFMPEG_PATH", "ffmpeg"))
DEFAULT_DB = PROJECT_ROOT / "data" / "db" / "musik.db"
DEFAULT_SR = 48000
SEGMENT_SEC = 30.0
MODEL_DIR = PROJECT_ROOT / "data" / "models"
ONNX_MODEL_PATH = MODEL_DIR / "clap_music_512.onnx"

def utcnow_iso():
    return datetime.now(timezone.utc).isoformat()

def get_audio_duration(file_path: Path) -> float:
    cmd = [
        str(FFMPEG_PATH), "-nostdin", "-v", "error",
        "-probesize", "32768", "-analyzeduration", "0",
        "-i", str(file_path)
    ]
    p = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, errors="replace")
    for line in p.stderr.splitlines():
        if "Duration:" in line:
            parts = line.split("Duration:")[1].split(",")[0].strip().split(":")
            if len(parts) == 3:
                h = float(parts[0])
                m = float(parts[1])
                s = float(parts[2])
                return h * 3600 + m * 60 + s
    return 180.0

def load_audio_window(file_path: Path, offset_sec: float, duration_sec: float) -> np.ndarray:
    cmd = [
        str(FFMPEG_PATH), "-nostdin", "-v", "error",
        "-ss", f"{max(0.0, offset_sec):.3f}",
        "-i", str(file_path),
        "-t", f"{max(0.1, duration_sec):.3f}",
        "-vn", "-sn", "-dn",
        "-threads", "1",
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

_ONNX_SESSION = None

def get_onnx_session():
    global _ONNX_SESSION
    if _ONNX_SESSION is not None:
        return _ONNX_SESSION
    if not ONNX_MODEL_PATH.is_file():
        return None
    try:
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _ONNX_SESSION = ort.InferenceSession(str(ONNX_MODEL_PATH), opts, providers=["CPUExecutionProvider"])
        return _ONNX_SESSION
    except Exception as e:
        print(f"[embedder_onnx] Warning loading ONNX model: {e}", file=sys.stderr)
        return None

def compute_lightweight_embedding(samples: np.ndarray) -> np.ndarray:
    """
    Fallback 512D spectral projection if ONNX model is not yet compiled on disk.
    Computes deterministic 512D mel-frequency log energy profile.
    """
    n_fft = 2048
    hop = 512
    # Simple STFT magnitude
    if len(samples) < n_fft:
        samples = np.pad(samples, (0, n_fft - len(samples)))
    
    # Take 512 frequency bin statistics
    n_chunks = min(64, len(samples) // hop)
    bins = 512
    spec = np.zeros(bins, dtype=np.float32)
    
    for i in range(n_chunks):
        chunk = samples[i * hop : i * hop + n_fft]
        if len(chunk) < n_fft:
            break
        windowed = chunk * np.hanning(len(chunk))
        fft_mag = np.abs(np.fft.rfft(windowed))[:bins]
        spec[:len(fft_mag)] += fft_mag
    
    # Log scale & normalize
    spec = np.log1p(spec)
    return l2_normalize(spec)

def compute_embedding(audio_path: Path, duration: float | None = None) -> np.ndarray:
    if duration is None:
        duration = get_audio_duration(audio_path)
    
    # Sample 3 windows: Intro (15%), Chorus (50%), Climax (75%)
    window_offsets = [
        max(0.0, duration * 0.15),
        max(0.0, duration * 0.50),
        max(0.0, duration * 0.75)
    ]
    
    session = get_onnx_session()
    vecs = []
    
    for offset in window_offsets:
        samples = load_audio_window(audio_path, offset, SEGMENT_SEC)
        if len(samples) == 0:
            continue
        
        if session is not None:
            try:
                # Shape: [1, N_samples]
                input_name = session.get_inputs()[0].name
                inp = samples.reshape(1, -1).astype(np.float32)
                out = session.run(None, {input_name: inp})[0]
                vec = out.squeeze().astype(np.float32)
                vecs.append(l2_normalize(vec))
                continue
            except Exception as e:
                print(f"[embedder_onnx] ONNX run error: {e}", file=sys.stderr)
        
        # Lightweight spectral fallback
        vec = compute_lightweight_embedding(samples)
        vecs.append(vec)
        
    if not vecs:
        return np.zeros(512, dtype=np.float32)
    
    avg_vec = np.mean(vecs, axis=0)
    return l2_normalize(avg_vec)

def update_db_feature(db_path: Path, track_id: int, vec: np.ndarray):
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

class MicroHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path in ("/health", "/status"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "service": "musik-onnx-embedder",
                "dim": 512,
                "engine": "onnxruntime" if _ONNX_SESSION else "spectral_vps",
                "ram_target": "80MB"
            }).encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path in ("/embed", "/api/embed"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                data = json.loads(body)

                audio_file = data.get("audio_path") or data.get("file")
                track_id = data.get("track_id")
                db_path = data.get("db_path") or str(DEFAULT_DB)

                if not audio_file:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{"ok":false,"error":"Missing audio_path"}')
                    return

                p = Path(audio_file)
                if not p.is_file():
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "error": f"File not found: {audio_file}"}).encode("utf-8"))
                    return

                vec = compute_embedding(p, duration=data.get("duration"))
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

def run_server(port: int = 8790):
    server = HTTPServer(("127.0.0.1", port), MicroHandler)
    print(f"[embedder_onnx] Ultra-lightweight ONNX Embedder running on http://127.0.0.1:{port} (RAM: ~80MB)")
    server.serve_forever()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Micro 512D Embedder for 1GB VPS")
    parser.add_argument("--server", action="store_true", help="Run HTTP daemon")
    parser.add_argument("--port", type=int, default=8790, help="HTTP daemon port")
    parser.add_argument("--audio", type=str, help="Single audio file to embed")
    parser.add_argument("--track-id", type=int, help="Track ID in SQLite")
    parser.add_argument("--db", type=str, default=str(DEFAULT_DB), help="SQLite database path")
    args = parser.parse_args()

    if args.server:
        run_server(args.port)
    elif args.audio:
        p = Path(args.audio)
        if not p.is_file():
            print(f"File not found: {args.audio}", file=sys.stderr)
            sys.exit(1)
        vec = compute_embedding(p)
        if args.track_id:
            update_db_feature(Path(args.db), args.track_id, vec)
        print(json.dumps({"ok": True, "track_id": args.track_id, "dim": len(vec)}))
    else:
        run_server(args.port)
