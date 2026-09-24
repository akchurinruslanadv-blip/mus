import json
import sqlite3
import os
import sys
import datetime
import ast
import pyarrow.parquet as pq

sys.stdout.reconfigure(encoding='utf-8')

PARQUET_PATH = r"data\spotify_2.3m_features.parquet"
DB_PATH = r"data\db\musik.db"

if not os.path.exists(PARQUET_PATH):
    print(f"Error: {PARQUET_PATH} not found!")
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

print("Importing 2.35M Parquet Dataset into external_catalog...")

def parse_artist(raw_str):
    if not raw_str:
        return ""
    raw_str = str(raw_str).strip()
    if raw_str.startswith("[") and raw_str.endswith("]"):
        try:
            arr = ast.literal_eval(raw_str)
            if isinstance(arr, list) and len(arr) > 0:
                return str(arr[0]).strip()
        except:
            cleaned = raw_str.strip("[]'\" ")
            return cleaned.split(",")[0].strip(" '\"")
    return raw_str

parquet_file = pq.ParquetFile(PARQUET_PATH)
total_read = 0
total_inserted = 0
total_skipped_speech = 0
total_skipped_duration = 0
batch = []

# Stream row groups
for rg_idx in range(parquet_file.num_row_groups):
    table = parquet_file.read_row_group(rg_idx)
    data = table.to_pydict()
    num_rows = len(table)

    names = data.get("track_name", [])
    artists = data.get("artists", [])
    albums = data.get("album_name", [])
    durations = data.get("duration_ms", [])
    dances = data.get("danceability", [])
    energies = data.get("energy", [])
    keys = data.get("key", [])
    louds = data.get("loudness", [])
    modes = data.get("mode", [])
    speeches = data.get("speechiness", [])
    acoustics = data.get("acousticness", [])
    instruments = data.get("instrumentalness", [])
    lives = data.get("liveness", [])
    valences = data.get("valence", [])
    tempos = data.get("tempo", [])

    for i in range(num_rows):
        total_read += 1
        try:
            title = str(names[i] or "").strip()
            artist = parse_artist(artists[i])
            if not artist or not title:
                continue

            duration_ms = float(durations[i] or 180000)
            duration_sec = round(duration_ms / 1000.0, 1)

            if duration_sec < 40 or duration_sec > 720:
                total_skipped_duration += 1
                continue

            speechiness = float(speeches[i] or 0)
            if speechiness > 0.35:
                total_skipped_speech += 1
                continue

            album = str(albums[i] or "").strip()

            features = {
                "danceability": round(float(dances[i] or 0), 4),
                "energy": round(float(energies[i] or 0), 4),
                "key": int(float(keys[i] or 0)),
                "loudness": round(float(louds[i] or 0), 2),
                "mode": int(float(modes[i] or 0)),
                "speechiness": round(speechiness, 4),
                "acousticness": round(float(acoustics[i] or 0), 4),
                "instrumentalness": round(float(instruments[i] or 0), 4),
                "liveness": round(float(lives[i] or 0), 4),
                "valence": round(float(valences[i] or 0), 4),
                "tempo": round(float(tempos[i] or 0), 2),
            }

            features_json = json.dumps(features, separators=(',', ':'))

            batch.append((
                artist,
                title,
                album,
                duration_sec,
                "", # ytdl_id
                "General",
                features_json,
                now_str
            ))

            if len(batch) >= 20000:
                cursor.executemany(insert_sql, batch)
                conn.commit()
                total_inserted += len(batch)
                batch = []
                print(f"Processed {total_read} / {parquet_file.metadata.num_rows} rows... ({total_inserted} inserted)", flush=True)

        except Exception as e:
            continue

if batch:
    cursor.executemany(insert_sql, batch)
    conn.commit()
    total_inserted += len(batch)

cursor.execute("SELECT COUNT(*), COUNT(DISTINCT artist), COUNT(DISTINCT genre) FROM external_catalog")
total_tracks, total_artists, total_genres = cursor.fetchone()

print("==========================================================")
print(f"2.35M Parquet Import Complete!")
print(f"Total read: {total_read}")
print(f"Batches processed: {total_inserted}")
print(f"Skipped (speech > 0.35): {total_skipped_speech}")
print(f"Skipped (duration out of 40-720s): {total_skipped_duration}")
print(f"Total Catalog now contains: {total_tracks} unique tracks across {total_artists} artists!")
print("==========================================================")

conn.close()
