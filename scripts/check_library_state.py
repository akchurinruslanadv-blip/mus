import sqlite3
import os
from pathlib import Path

db_path = r"C:\Users\Admin\Desktop\musik-project\data\db\musik.db"
dyn_dir = Path(r"C:\Users\Admin\Desktop\musik-project\dynamic")

conn = sqlite3.connect(db_path)
c = conn.cursor()

print("--- DB Tracks ---")
db_tracks = {}
for r in c.execute("SELECT id, path, title, artist FROM tracks"):
    db_tracks[r[0]] = {"path": r[1], "title": r[2], "artist": r[3]}
    print(r)

print("\n--- Features ---")
feat_tracks = {}
for r in c.execute("SELECT track_id, embedding_dim, status FROM features"):
    feat_tracks[r[0]] = (r[1], r[2])
    print(r)

print("\n--- Files in dynamic/ ---")
for f in dyn_dir.iterdir():
    if f.suffix.lower() in [".webm", ".opus", ".m4a", ".mp3", ".flac", ".ogg", ".wav"]:
        print(f"{f.name} ({f.stat().st_size} bytes)")
