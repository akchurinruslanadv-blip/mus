// extensions/fetcher/src/fetcher.ts: Cascade Stream Fetcher & Pipeline
import * as path from "@std/path";
import { config } from "./config.ts";
import { getDb, upsertTrack, isTrackPinned, markTrackUnavailable } from "./db.ts";
import { compute512DEmbedding } from "./embedder_client.ts";
import { ensureCookies } from "./cookie_manager.ts";
import { FetchOptions, FetchResult } from "./types.ts";

export async function fetchAudioStream(
  queryOrUrl: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const startTime = performance.now();
  const targetDir = options.mode === "pin" ? config.favoritesDir : config.dynamicDir;
  await Deno.mkdir(targetDir, { recursive: true });

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    PATH: `${config.binDir};${Deno.env.get("PATH") || ""}`,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8"
  };

  // Determine search strategy
  // 0. Cached ytdl_id check, 1. Direct URL/ID, 2. YouTube fallback search
  let knownYtdlId = options.preferredYtdlId;
  const isDirectUrl = queryOrUrl.startsWith("http://") || 
                      queryOrUrl.startsWith("https://") || 
                      /^[a-zA-Z0-9_-]{11}$/.test(queryOrUrl);

  // If not direct URL, check if ytdl_id is already cached in SQLite (tracks or external_catalog)
  if (!knownYtdlId && !isDirectUrl) {
    try {
      const db = getDb();
      const dashIdx = queryOrUrl.indexOf(" - ");
      if (dashIdx > 0) {
        const a = queryOrUrl.slice(0, dashIdx).trim();
        const t = queryOrUrl.slice(dashIdx + 3).trim();
        const catRow = db.prepare(`
          SELECT ytdl_id FROM external_catalog 
          WHERE (LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?)))
            AND ytdl_id IS NOT NULL AND length(ytdl_id) >= 11
          LIMIT 1
        `).get(a, t) as { ytdl_id?: string } | undefined;
        if (catRow?.ytdl_id) knownYtdlId = catRow.ytdl_id;

        if (!knownYtdlId) {
          const tRow = db.prepare(`
            SELECT ytdl_id FROM tracks 
            WHERE (LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?)))
              AND ytdl_id IS NOT NULL AND length(ytdl_id) >= 11
            LIMIT 1
          `).get(a, t) as { ytdl_id?: string } | undefined;
          if (tRow?.ytdl_id) knownYtdlId = tRow.ytdl_id;
        }
      }
    } catch {}
  }

  const strategies: { source: "youtube_music" | "youtube_fallback"; query: string }[] = [];

  if (knownYtdlId) {
    strategies.push({
      source: "youtube_fallback",
      query: `https://www.youtube.com/watch?v=${knownYtdlId}`
    });
  } else if (isDirectUrl) {
    strategies.push({ source: "youtube_music", query: queryOrUrl });
  } else {
    // Only search by keywords when we do NOT have a known ytdl_id!
    strategies.push({ 
      source: "youtube_fallback", 
      query: `ytsearch1:${queryOrUrl} audio` 
    });
    if (options.fallbackSearch !== false) {
      strategies.push({ 
        source: "youtube_fallback", 
        query: `ytsearch1:${queryOrUrl}` 
      });
    }
  }

  let finalFilePath = "";
  let finalDuration = 180;
  let finalSize = 0;
  let finalYtdlId = "";
  let finalYtTitle = "";
  let finalYtUploader = "";
  let finalSource: "youtube_music" | "youtube_fallback" = "youtube_fallback";
  let lastError = "";

  for (const strat of strategies) {
    const cookiesFile = ensureCookies();
    const outputTemplate = path.join(targetDir, "%(id)s.%(ext)s");
    const args = [
      "--no-playlist",
      "--socket-timeout", "10",
      "--retries", "2",
      "--concurrent-fragments", "2",
      "-f", config.audioFormat,
      "--encoding", "utf-8",
      "--no-warnings",
      "--match-filter", `duration <= ${config.maxTrackDurationSec} & duration >= ${config.minTrackDurationSec}`,
    ];
    if (cookiesFile) {
      args.push("--cookies", cookiesFile);
    }
    args.push(
      strat.query,
      "-o", outputTemplate,
      "--print", "after_move:%(filepath)s|||%(duration)s|||%(filesize,filesize_approx)s|||%(id)s|||%(title)s|||%(uploader)s"
    );

    try {
      const cmd = new Deno.Command(config.ytdlpPath, {
        args,
        env,
        stdout: "piped",
        stderr: "piped"
      });

      const child = cmd.spawn();
      const timeoutMs = 25000;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const outputPromise = child.output();
      const timeoutPromise = new Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>((_, reject) => {
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          reject(new Error("yt-dlp command timed out after 25s"));
        }, timeoutMs);
      });

      let res: { code: number; stdout: Uint8Array; stderr: Uint8Array };
      try {
        res = await Promise.race([outputPromise, timeoutPromise]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (res.code === 0) {
        const rawOutput = new TextDecoder("utf-8").decode(res.stdout).trim();
        const line = rawOutput.split(/\r?\n/).find(l => l.includes("|||"));
        if (line) {
          const parts = line.split("|||");
          const candidatePath = parts[0]?.trim();
          if (candidatePath && await Deno.stat(candidatePath).catch(() => null)) {
            const candidateDuration = parseFloat(parts[1]) || 180;
            const candidateTitle = parts[4]?.trim() || "";
            const candidateUploader = parts[5]?.trim() || "";

            // Guard against podcast/audiobook/speech leakage if not a direct URL
            const fullTitle = `${candidateTitle} ${candidateUploader}`.toLowerCase();
            const hasNonMusicKeyword = config.nonMusicKeywords.some(kw => fullTitle.includes(kw));
            const isNonMusic = !isDirectUrl && (
              candidateDuration > config.maxTrackDurationSec ||
              candidateDuration < config.minTrackDurationSec ||
              hasNonMusicKeyword
            );

            if (isNonMusic) {
              console.warn(`[fetcher] Rejected non-music / podcast candidate: "${candidateTitle}" (${candidateDuration}s)`);
              try { await Deno.remove(candidatePath); } catch {}
              continue; // Try next strategy
            }

            finalFilePath = candidatePath;
            finalDuration = candidateDuration;
            finalSize = parseInt(parts[2]) || 0;
            finalYtdlId = parts[3]?.trim() || path.basename(candidatePath).split(".")[0];
            finalYtTitle = candidateTitle;
            finalYtUploader = candidateUploader;
            finalSource = strat.source;
            break; // Successfully resolved!
          }
        }
      } else {
        lastError = new TextDecoder().decode(res.stderr).trim();
      }
    } catch (e) {
      lastError = String(e);
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  // If download failed across all cascade levels
  if (!finalFilePath) {
    markTrackUnavailable(queryOrUrl);
    return {
      success: false,
      durationMs,
      source: finalSource,
      error: lastError || "Audio stream could not be resolved from open sources"
    };
  }

  // Parse artist and title from real YouTube metadata or query fallback
  let artist = "Various Artists";
  let title = queryOrUrl;
  if (finalYtTitle) {
    if (finalYtTitle.includes(" - ")) {
      const parts = finalYtTitle.split(" - ");
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    } else {
      title = finalYtTitle.trim();
      if (finalYtUploader) {
        artist = finalYtUploader.replace(/ - Topic$/, "").trim();
      }
    }
    // Clean up typical YouTube tags
    title = title.replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyrics|Official\s*Audio|Official|Lyric\s*Video)[\)\]]/gi, "").trim();
  } else if (queryOrUrl.includes(" - ")) {
    const parts = queryOrUrl.split(" - ");
    artist = parts[0].trim();
    title = parts.slice(1).join(" - ").trim();
  }

  // Upsert track into SQLite
  const db = getDb();
  const trackId = upsertTrack({
    path: finalFilePath,
    title,
    artist,
    duration: finalDuration,
    fileSize: finalSize,
    ytdlId: finalYtdlId
  }, db);

  // Permanently preserve track metadata and source URL in external_catalog
  if (finalYtdlId) {
    const sourceUrl = `https://www.youtube.com/watch?v=${finalYtdlId}`;
    try {
      db.prepare(`
        INSERT INTO external_catalog (artist, title, ytdl_id, source_url, duration_sec, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist, title) DO UPDATE SET
          ytdl_id = COALESCE(excluded.ytdl_id, external_catalog.ytdl_id),
          source_url = COALESCE(excluded.source_url, external_catalog.source_url),
          duration_sec = COALESCE(excluded.duration_sec, external_catalog.duration_sec)
      `).run(artist, title, finalYtdlId, sourceUrl, finalDuration, new Date().toISOString());
    } catch {}
  }

  const pinned = isTrackPinned(trackId, db);

  // Extract 512D parameters in background without blocking audio delivery
  compute512DEmbedding(finalFilePath, trackId).catch(err => {
    console.warn(`[fetcher] Background 512D embedding error for track ${trackId}:`, err);
  });

  // Notify Go player of new ready track
  notifyPlayerReload().catch(() => {});

  return {
    success: true,
    trackId,
    filePath: finalFilePath,
    filename: path.basename(finalFilePath),
    durationSec: finalDuration,
    sizeBytes: finalSize,
    durationMs,
    ytdlId: finalYtdlId,
    isPinned: pinned,
    source: finalSource
  };
}

export async function notifyPlayerReload(): Promise<boolean> {
  try {
    const res = await fetch(`${config.playerUrl}/api/reload`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchTrackAudio(
  artist: string,
  title: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const query = `${artist} - ${title}`.trim();
  const res = await fetchAudioStream(query, options);
  if (res.success && res.trackId && artist && title) {
    try {
      const db = getDb();
      db.prepare(`UPDATE tracks SET artist = ?, title = ? WHERE id = ?`).run(artist.trim(), title.trim(), res.trackId);
    } catch {}
  }
  return res;
}

// P2: Automatic or manual yt-dlp updater
export async function updateYtDlp(): Promise<{ success: boolean; version?: string; output?: string; error?: string }> {
  try {
    console.log(`[yt-dlp] Checking and updating yt-dlp binary (${config.ytdlpPath})...`);
    const cmd = new Deno.Command(config.ytdlpPath, {
      args: ["-U"],
      stdout: "piped",
      stderr: "piped"
    });
    const res = await cmd.output();
    const out = new TextDecoder().decode(res.stdout).trim();
    const err = new TextDecoder().decode(res.stderr).trim();

    // Query version
    const verCmd = new Deno.Command(config.ytdlpPath, {
      args: ["--version"],
      stdout: "piped"
    });
    const verRes = await verCmd.output();
    const version = new TextDecoder().decode(verRes.stdout).trim();

    console.log(`[yt-dlp] Current version: ${version}. Update output: ${out || err || 'Up to date'}`);

    return {
      success: res.code === 0,
      version,
      output: out || err || "yt-dlp is up-to-date"
    };
  } catch (e) {
    console.warn(`[yt-dlp] Update failed:`, e);
    return { success: false, error: String(e) };
  }
}

// Online search fallback across Google & YouTube Music via yt-dlp
export async function searchOnlineTracks(
  query: string,
  limit = 8
): Promise<{ id: string; title: string; artist: string; duration_sec: number; url: string }[]> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    PATH: `${config.binDir};${Deno.env.get("PATH") || ""}`,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };

  const cookiesFile = ensureCookies();
  const args = [
    "--no-playlist",
    "--socket-timeout", "10",
    "--encoding", "utf-8",
    "--no-warnings",
  ];
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }
  args.push(`ytsearch${limit}:${query} audio`, "--print", "%(id)s|||%(title)s|||%(uploader)s|||%(duration)s");

  try {
    const cmd = new Deno.Command(config.ytdlpPath, { args, env, stdout: "piped", stderr: "piped" });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return [];

    const text = new TextDecoder().decode(stdout).trim();
    if (!text) return [];

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      const parts = line.split("|||");
      if (parts.length < 3) continue;
      const ytdlId = parts[0].trim();
      let title = parts[1].trim();
      let artist = parts[2].trim();
      const dur = parseFloat(parts[3] || "180");

      if (title.includes(" - ")) {
        const p = title.split(" - ");
        artist = p[0].trim();
        title = p.slice(1).join(" - ").trim();
      }

      // Strip common suffixes
      title = title.replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?Video|Audio|Lyrics|Official\s*Audio|Official|Lyric\s*Video)[\)\]]/gi, "").trim();

      results.push({
        id: ytdlId,
        title: title || parts[1].trim(),
        artist: artist || parts[2].trim(),
        duration_sec: Math.round(dur),
        url: `https://www.youtube.com/watch?v=${ytdlId}`
      });
    }
    return results;
  } catch {
    return [];
  }
}


