import sqlite3
import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

db_path = r"C:\Users\Admin\Desktop\musik-project\data\db\musik.db"
conn = sqlite3.connect(db_path)

# Clear old test listening history & sessions so fresh radio start has all tracks available
conn.execute("DELETE FROM play_sessions")
conn.execute("DELETE FROM listening_history")
conn.commit()
print("Cleaned old play_sessions and listening_history.")

# Trigger reload in musik-player
req = urllib.request.Request("http://127.0.0.1:8787/api/reload", method="POST")
with urllib.request.urlopen(req) as resp:
    res = json.loads(resp.read().decode())
    print("Reload response:", res)

# Test starting radio
req = urllib.request.Request(
    "http://127.0.0.1:8787/api/radio/start", 
    data=json.dumps({}).encode('utf-8'),
    headers={"Content-Type": "application/json"},
    method="POST"
)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
    print("\n--- Radio Start Test ---")
    print("Session ID:", data.get("session_id"))
    print("Current Track:", data.get("current", {}).get("artist"), "-", data.get("current", {}).get("title"))
    print("Queue count:", len(data.get("queue", [])))
    for q in data.get("queue", []):
        print(f"  -> Next: {q.get('artist')} - {q.get('title')}")

# Test skipping track (advancing radio)
sess_id = data.get("session_id")
curr_id = data.get("current", {}).get("id")
req = urllib.request.Request(
    "http://127.0.0.1:8787/api/events",
    data=json.dumps({
        "type": "skip",
        "session_id": sess_id,
        "track_id": curr_id,
        "reason": "skipped"
    }).encode('utf-8'),
    headers={"Content-Type": "application/json"},
    method="POST"
)
with urllib.request.urlopen(req) as resp:
    skip_data = json.loads(resp.read().decode())
    print("\n--- Radio Skip Test ---")
    print("Next Track:", skip_data.get("next", {}).get("artist"), "-", skip_data.get("next", {}).get("title"))
    print("Remaining queue count:", len(skip_data.get("queue", [])))
