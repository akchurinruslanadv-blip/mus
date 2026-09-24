import urllib.request
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = "https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/main/dataset.csv"
dest = r"C:\Users\Admin\Desktop\musik-project\data\spotify_114k_tracks.csv"

os.makedirs(os.path.dirname(dest), exist_ok=True)

print(f"Downloading Spotify 114k 12D Audio Features dataset from:\n  {url}")

def reporthook(count, block_size, total_size):
    if total_size > 0:
        percent = int(count * block_size * 100 / total_size)
        mb = (count * block_size) / (1024 * 1024)
        total_mb = total_size / (1024 * 1024)
        if count % 100 == 0 or percent == 100:
            print(f"\rProgress: {percent}% ({mb:.1f} MB / {total_mb:.1f} MB)", end="", flush=True)

urllib.request.urlretrieve(url, dest, reporthook)
print("\nDownload complete!")

size = os.path.getsize(dest)
print(f"File size: {size / 1024 / 1024:.2f} MB")

with open(dest, "r", encoding="utf-8", errors="replace") as f:
    for i in range(5):
        print(f"Row {i}: {f.readline().strip()}")
