// extensions/fetcher/src/embedder_client.ts: Client to 512D CLAP Feature Extractor with Sequential Queue
import { config } from "./config.ts";
import { getDb, has512Embedding } from "./db.ts";

export interface EmbedResult {
  ok: boolean;
  dim: number;
  output: string;
  error?: string;
}

interface EmbedTask {
  audioPath: string;
  trackId: number;
}

const _queue: EmbedTask[] = [];
const _listeners = new Map<number, ((res: EmbedResult) => void)[]>();
let _isProcessing = false;

export function compute512DEmbedding(audioPath: string, trackId: number): Promise<EmbedResult> {
  // If track already has 512D embedding in DB, skip immediately
  try {
    if (has512Embedding(trackId)) {
      return Promise.resolve({ ok: true, dim: 512, output: "already_computed" });
    }
  } catch {}

  return new Promise<EmbedResult>((resolve) => {
    const existing = _listeners.get(trackId);
    if (existing) {
      existing.push(resolve);
      return;
    }

    _listeners.set(trackId, [resolve]);
    _queue.push({ audioPath, trackId });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (_isProcessing || _queue.length === 0) return;
  _isProcessing = true;

  while (_queue.length > 0) {
    const task = _queue.shift()!;
    let res: EmbedResult;
    try {
      res = await runPythonEmbedder(task.audioPath, task.trackId);
    } catch (e) {
      res = { ok: false, dim: 0, output: "", error: String(e) };
    }

    const callbacks = _listeners.get(task.trackId) || [];
    _listeners.delete(task.trackId);
    for (const cb of callbacks) {
      try { cb(res); } catch {}
    }
  }

  _isProcessing = false;
}

const EMBEDDER_DAEMON_URL = Deno.env.get("EMBEDDER_URL") || "http://127.0.0.1:8790";

async function runPythonEmbedder(audioPath: string, trackId: number): Promise<EmbedResult> {
  // 1. Try fast HTTP daemon first (1.5s vs 15s)
  try {
    const res = await fetch(`${EMBEDDER_DAEMON_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_path: audioPath,
        track_id: trackId,
        db_path: config.dbPath
      }),
      signal: AbortSignal.timeout(25000)
    });

    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        return { ok: true, dim: data.dim || 512, output: "daemon_ok" };
      }
    }
  } catch {
    // Daemon not running or unreachable — fallback to CLI
  }

  // 2. Fallback to CLI process execution
  return runPythonCli(audioPath, trackId);
}

async function runPythonCli(audioPath: string, trackId: number): Promise<EmbedResult> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    OMP_NUM_THREADS: String(config.maxCpuThreads),
    MKL_NUM_THREADS: String(config.maxCpuThreads),
    PATH: `${config.binDir};${Deno.env.get("PATH") || ""}`
  };

  try {
    const cmd = new Deno.Command(config.pythonPath, {
      args: [
        config.embedderPath,
        audioPath,
        "--track-id", trackId.toString(),
        "--db", config.dbPath
      ],
      env,
      stdout: "piped",
      stderr: "piped"
    });

    const { code, stdout, stderr } = await cmd.output();
    const outStr = new TextDecoder().decode(stdout).trim();
    const errStr = new TextDecoder().decode(stderr).trim();

    if (code !== 0) {
      return { ok: false, dim: 0, output: outStr, error: errStr || "Embedder exited with non-zero code" };
    }

    return { ok: true, dim: 512, output: outStr };
  } catch (e) {
    return { ok: false, dim: 0, output: "", error: String(e) };
  }
}
