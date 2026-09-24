// scripts/repair_corrupted_titles.ts: Repair tracks with corrupted encoding / replacement characters
import { Database } from "@db/sqlite";
import * as path from "@std/path";

const projectRoot = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const dbPath = path.resolve(projectRoot, "data", "db", "musik.db");
const ytdlpPath = path.resolve(projectRoot, "bin", "yt-dlp.exe");

console.log("==================================================");
console.log(" 🛠️ Repairing corrupted track titles in SQLite...");
console.log(` Database: ${dbPath}`);
console.log("==================================================");

const db = new Database(dbPath);
try {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 15000;");
} catch {}

const allTracks = db.prepare("SELECT id, artist, title, path FROM tracks").all() as any[];

const corrupted = allTracks.filter(t => {
  const a = t.artist || "";
  const title = t.title || "";
  return a.includes("\ufffd") || title.includes("\ufffd") || /[\uFFFD\u0080-\u009F]/.test(a) || /[\uFFFD\u0080-\u009F]/.test(title);
});

console.log(`Found ${corrupted.length} tracks with corrupted characters out of ${allTracks.length} total tracks.\n`);

if (corrupted.length === 0) {
  console.log("✅ No corrupted tracks found! All titles are clean.");
  db.close();
  Deno.exit(0);
}

const updateStmt = db.prepare("UPDATE tracks SET artist = ?, title = ?, updated_at = ? WHERE id = ?");

async function fetchRealMetadata(ytdlId: string): Promise<{ artist: string; title: string } | null> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8"
  };

  try {
    const cmd = new Deno.Command(ytdlpPath, {
      args: [
        "--skip-download",
        "--no-warnings",
        "--encoding", "utf-8",
        "--print", "%(uploader)s|||%(title)s",
        `https://youtu.be/${ytdlId}`
      ],
      env,
      stdout: "piped",
      stderr: "piped"
    });

    const res = await cmd.output();
    if (res.code === 0) {
      const out = new TextDecoder("utf-8").decode(res.stdout).trim();
      const parts = out.split("|||");
      const uploader = parts[0]?.trim() || "";
      const rawTitle = parts[1]?.trim() || "";

      if (!rawTitle) return null;

      let artist = "Various Artists";
      let title = rawTitle;

      if (rawTitle.includes(" - ")) {
        const segs = rawTitle.split(" - ");
        artist = segs[0].trim();
        title = segs.slice(1).join(" - ").trim();
      } else {
        title = rawTitle.trim();
        if (uploader) {
          artist = uploader.replace(/ - Topic$/, "").trim();
        }
      }

      // Clean typical tags
      title = title.replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyrics|Official\s*Audio|Official|Lyric\s*Video)[\)\]]/gi, "").trim();

      return { artist: artist || "Unknown Artist", title: title || rawTitle };
    }
  } catch {}
  return null;
}

let fixedCount = 0;
let failedCount = 0;

// Process with concurrency pool of 4
const CONCURRENCY = 4;
for (let i = 0; i < corrupted.length; i += CONCURRENCY) {
  const batch = corrupted.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map(async (t) => {
    // Extract YouTube ID
    let ytdlId = "";
    if (t.title && /^[A-Za-z0-9_-]{11}$/.test(t.title.trim())) {
      ytdlId = t.title.trim();
    } else if (t.path) {
      const base = path.basename(t.path).split(".")[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(base)) {
        ytdlId = base;
      }
    }

    if (!ytdlId) {
      console.log(`⚠️ [#${t.id}] Could not extract video ID (path: ${t.path})`);
      return { id: t.id, success: false, meta: null };
    }

    const meta = await fetchRealMetadata(ytdlId);
    return { id: t.id, success: !!meta && !meta.artist.includes("\ufffd") && !meta.title.includes("\ufffd"), meta, ytdlId };
  }));

  // Perform updates sequentially to avoid SQLite write lock contention
  for (const res of results) {
    if (res.success && res.meta) {
      let saved = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const now = new Date().toISOString();
          updateStmt.run(res.meta.artist, res.meta.title, now, res.id);
          console.log(`✅ [#${res.id}] Repaired: "${res.meta.artist}" — "${res.meta.title}"`);
          fixedCount++;
          saved = true;
          break;
        } catch (err) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      if (!saved) {
        console.log(`❌ [#${res.id}] DB lock prevented update`);
        failedCount++;
      }
    } else {
      console.log(`❌ [#${res.id}] Failed to retrieve clean metadata for ${res.ytdlId || "unknown"}`);
      failedCount++;
    }
  }
}

console.log("\n==================================================");
console.log(` 🎉 Repair finished!`);
console.log(` Successfully fixed: ${fixedCount} tracks`);
console.log(` Failed/Skipped:     ${failedCount} tracks`);
console.log("==================================================");

db.close();
