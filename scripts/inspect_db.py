import sqlite3
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

conn = sqlite3.connect(r"C:\Users\Admin\Desktop\musik-project\data\db\musik.db")
c = conn.cursor()

print("Verifying audio files for ready tracks:")
all_ok = True
for r in c.execute("SELECT t.id, t.artist, t.title, t.path FROM tracks t JOIN features f ON f.track_id=t.id WHERE f.status='ready'"):
    exists = os.path.isfile(r[3])
    if not exists:
        all_ok = False
    print(f"  [{'EXISTS' if exists else 'MISSING'}] Track {r[0]}: {r[1]} - {r[2]}")

print(f"\nAll files present on disk: {all_ok}")
