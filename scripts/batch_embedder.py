import sys
import os
import sqlite3
from pathlib import Path

# Fix Windows console UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
BIN_DIR = PROJECT_ROOT / "bin"
DEFAULT_DB = PROJECT_ROOT / "data" / "db" / "musik.db"

# Import functions from embedder
sys.path.insert(0, str(SCRIPT_DIR))
from embedder import get_model, compute_clap_embedding, update_db_feature

def main():
    conn = sqlite3.connect(str(DEFAULT_DB))
    c = conn.cursor()
    
    # Get pending tracks
    rows = c.execute("""
        SELECT t.id, t.path, t.title, t.artist 
        FROM tracks t 
        JOIN features f ON f.track_id = t.id 
        WHERE f.status != 'ready'
    """).fetchall()
    
    print(f"[batch_embedder] Found {len(rows)} pending tracks to embed.")
    if not rows:
        return
        
    # Preload model once
    get_model()
    
    for track_id, path_str, title, artist in rows:
        p = Path(path_str)
        if not p.is_file():
            print(f"Skipping track {track_id}: file missing at {p}")
            continue
        print(f"[batch_embedder] Embedding Track {track_id}: {artist} - {title}...")
        try:
            vec = compute_clap_embedding(p)
            update_db_feature(DEFAULT_DB, track_id, vec)
            print(f"[batch_embedder] Track {track_id} ready! (dim=512)")
        except Exception as e:
            print(f"[batch_embedder] Error embedding track {track_id}: {e}")

if __name__ == "__main__":
    main()
