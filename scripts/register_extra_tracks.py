import sqlite3
import datetime
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

db_path = r"C:\Users\Admin\Desktop\musik-project\data\db\musik.db"
dyn_dir = Path(r"C:\Users\Admin\Desktop\musik-project\dynamic")

conn = sqlite3.connect(db_path)
c = conn.cursor()

new_tracks = [
    {
        "filename": "Александр Пушной - Shape of my heart Sting 😬🎸METAL cover by Pushnoy [jIGCp432AYQ].webm",
        "title": "Shape of my heart (Metal cover)",
        "artist": "Александр Пушной",
        "album": "Covers",
        "duration": 220.0
    },
    {
        "filename": "YOASOBI, Echoes - YOASOBI「アイドル」 Official Music Video [ZRtdQ81jPUQ].webm",
        "title": "アイドル (Idol)",
        "artist": "YOASOBI",
        "album": "Idol",
        "duration": 215.0
    }
]

now = datetime.datetime.now(datetime.timezone.utc).isoformat()

for t in new_tracks:
    file_path = dyn_dir / t["filename"]
    if not file_path.is_file():
        print(f"File not found: {file_path}")
        continue
    size = file_path.stat().st_size
    path_str = str(file_path)
    
    # Check if path already in tracks
    existing = c.execute("SELECT id FROM tracks WHERE path = ?", (path_str,)).fetchone()
    if existing:
        print(f"Track already in DB: id={existing[0]} ({t['title']})")
        track_id = existing[0]
    else:
        c.execute("""
            INSERT INTO tracks (path, title, artist, album, duration, file_size, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (path_str, t["title"], t["artist"], t["album"], t["duration"], size, now, now))
        track_id = c.lastrowid
        print(f"Inserted track id={track_id} ({t['title']})")
    
    # Ensure in features
    c.execute("""
        INSERT INTO features (track_id, status, computed_at)
        VALUES (?, 'pending', ?)
        ON CONFLICT(track_id) DO NOTHING
    """, (track_id, now))

conn.commit()
print("Done registering extra tracks.")
