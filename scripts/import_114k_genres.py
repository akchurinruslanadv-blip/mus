import csv
import json
import sqlite3
import os
import sys
import datetime

sys.stdout.reconfigure(encoding='utf-8')

CSV_PATH = r"data\spotify_114k_genres.csv"
DB_PATH = r"data\db\musik.db"

if not os.path.exists(CSV_PATH):
    print(f"Error: {CSV_PATH} not found!")
    sys.exit(1)

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Enable WAL and high-speed pragma
cursor.execute("PRAGMA journal_mode = WAL;")
cursor.execute("PRAGMA synchronous = NORMAL;")
cursor.execute("PRAGMA busy_timeout = 5000;")

insert_sql = """
INSERT INTO external_catalog (
    artist, title, album, duration_sec, ytdl_id, genre, features_json, is_available, added_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
ON CONFLICT(artist, title) DO UPDATE SET
    album = CASE WHEN external_catalog.album IS NULL OR external_catalog.album = '' THEN excluded.album ELSE external_catalog.album END,
    genre = CASE WHEN external_catalog.genre IS NULL OR external_catalog.genre = 'General' THEN excluded.genre ELSE external_catalog.genre END,
    features_json = excluded.features_json
"""

now_str = datetime.datetime.utcnow().isoformat()

print("Importing 114k Spotify Genres Dataset into external_catalog...")
batch = []
total_read = 0
total_inserted = 0
total_skipped_speech = 0
total_skipped_duration = 0

with open(CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
    reader = csv.DictReader(f)
    for row in reader:
        total_read += 1
        try:
            # Clean artist and title
            raw_artists = row.get("artists", "").strip()
            # Often multiple artists are separated by ';' in this dataset
            artist = raw_artists.split(";")[0].strip() if raw_artists else ""
            title = row.get("track_name", "").strip()
            if not artist or not title:
                continue

            duration_ms = float(row.get("duration_ms", 180000) or 180000)
            duration_sec = round(duration_ms / 1000.0, 1)

            # Music Guard filter: 40s - 720s
            if duration_sec < 40 or duration_sec > 720:
                total_skipped_duration += 1
                continue

            speechiness = float(row.get("speechiness", 0) or 0)
            # Speech Guard: skip spoken word / podcasts
            if speechiness > 0.35:
                total_skipped_speech += 1
                continue

            album = row.get("album_name", "").strip()
            genre = row.get("track_genre", "General").strip().title()

            features = {
                "danceability": round(float(row.get("danceability", 0) or 0), 4),
                "energy": round(float(row.get("energy", 0) or 0), 4),
                "key": int(float(row.get("key", 0) or 0)),
                "loudness": round(float(row.get("loudness", 0) or 0), 2),
                "mode": int(float(row.get("mode", 0) or 0)),
                "speechiness": round(speechiness, 4),
                "acousticness": round(float(row.get("acousticness", 0) or 0), 4),
                "instrumentalness": round(float(row.get("instrumentalness", 0) or 0), 4),
                "liveness": round(float(row.get("liveness", 0) or 0), 4),
                "valence": round(float(row.get("valence", 0) or 0), 4),
                "tempo": round(float(row.get("tempo", 0) or 0), 2),
            }

            features_json = json.dumps(features, separators=(',', ':'))

            batch.append((
                artist,
                title,
                album,
                duration_sec,
                "", # ytdl_id empty for now
                genre,
                features_json,
                now_str
            ))

            if len(batch) >= 5000:
                cursor.executemany(insert_sql, batch)
                conn.commit()
                total_inserted += len(batch)
                batch = []
                print(f"Processed {total_read} rows... ({total_inserted} inserted/merged)", flush=True)

        except Exception as e:
            continue

if batch:
    cursor.executemany(insert_sql, batch)
    conn.commit()
    total_inserted += len(batch)

cursor.execute("SELECT COUNT(*), COUNT(DISTINCT artist), COUNT(DISTINCT genre) FROM external_catalog")
total_tracks, total_artists, total_genres = cursor.fetchone()

print("==========================================================")
print(f"Import Complete!")
print(f"Total read: {total_read}")
print(f"Total inserted/updated: {total_inserted}")
print(f"Skipped (speech > 0.35): {total_skipped_speech}")
print(f"Skipped (duration out of 40-720s): {total_skipped_duration}")
print(f"Database now contains: {total_tracks} tracks across {total_artists} artists and {total_genres} genres!")
print("==========================================================")

conn.close()
