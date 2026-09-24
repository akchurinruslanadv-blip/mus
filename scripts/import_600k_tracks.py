import csv
import json
import sqlite3
import os
import sys
import datetime
import ast

sys.stdout.reconfigure(encoding='utf-8')

CSV_PATH = r"data\spotify_600k_tracks.csv"
DB_PATH = r"data\db\musik.db"

if not os.path.exists(CSV_PATH):
    print(f"Error: {CSV_PATH} not found!")
    sys.exit(1)

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

cursor.execute("PRAGMA journal_mode = WAL;")
cursor.execute("PRAGMA synchronous = NORMAL;")
cursor.execute("PRAGMA busy_timeout = 5000;")

insert_sql = """
INSERT INTO external_catalog (
    artist, title, album, duration_sec, ytdl_id, genre, features_json, is_available, added_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
ON CONFLICT(artist, title) DO NOTHING
"""

now_str = datetime.datetime.utcnow().isoformat()

print("Importing 600k Spotify Tracks Dataset into external_catalog...")
batch = []
total_read = 0
total_inserted = 0
total_skipped_speech = 0
total_skipped_duration = 0

def parse_artist(raw_str):
    raw_str = raw_str.strip()
    if raw_str.startswith("[") and raw_str.endswith("]"):
        try:
            arr = ast.literal_eval(raw_str)
            if isinstance(arr, list) and len(arr) > 0:
                return str(arr[0]).strip()
        except:
            cleaned = raw_str.strip("[]'\" ")
            return cleaned.split(",")[0].strip(" '\"")
    return raw_str

with open(CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
    reader = csv.DictReader(f)
    for row in reader:
        total_read += 1
        try:
            title = row.get("name", "").strip()
            artist = parse_artist(row.get("artists", ""))
            if not artist or not title:
                continue

            duration_ms = float(row.get("duration_ms", 180000) or 180000)
            duration_sec = round(duration_ms / 1000.0, 1)

            # Music Guard filter: 40s - 720s
            if duration_sec < 40 or duration_sec > 720:
                total_skipped_duration += 1
                continue

            speechiness = float(row.get("speechiness", 0) or 0)
            if speechiness > 0.35:
                total_skipped_speech += 1
                continue

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
                "", # album
                duration_sec,
                "", # ytdl_id
                "General",
                features_json,
                now_str
            ))

            if len(batch) >= 10000:
                cursor.executemany(insert_sql, batch)
                conn.commit()
                total_inserted += len(batch)
                batch = []
                print(f"Processed {total_read} rows... ({total_inserted} inserted)", flush=True)

        except Exception as e:
            continue

if batch:
    cursor.executemany(insert_sql, batch)
    conn.commit()
    total_inserted += len(batch)

cursor.execute("SELECT COUNT(*), COUNT(DISTINCT artist) FROM external_catalog")
total_tracks, total_artists = cursor.fetchone()

print("==========================================================")
print(f"Import Complete!")
print(f"Total read: {total_read}")
print(f"Processed in batches: {total_inserted}")
print(f"Skipped (speech > 0.35): {total_skipped_speech}")
print(f"Skipped (duration out of 40-720s): {total_skipped_duration}")
print(f"External Catalog now contains: {total_tracks} unique tracks across {total_artists} artists!")
print("==========================================================")

conn.close()
