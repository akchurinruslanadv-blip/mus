with open(r"C:\Users\Admin\Desktop\musik-project\musik-main\player\internal\static\app.js", "r", encoding="utf-8") as f:
    lines = f.readlines()

for idx, line in enumerate(lines):
    if "next" in line.lower() or "skip" in line.lower() or "track_end" in line.lower():
        print(f"{idx+1}: {line.strip()[:120]}")
