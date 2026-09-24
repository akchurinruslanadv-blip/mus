"""Load three fixed windows from a track: start / middle / end."""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np

# Strategy id — bump when windowing changes so cache invalidates.
SEGMENT_STRATEGY = "clap_3x30_v1"
DEFAULT_SEGMENT_SEC = 30.0
DEFAULT_SR = 48_000

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SegmentWindow:
    name: str
    offset_sec: float
    duration_sec: float


def plan_windows(duration_sec: float, segment_sec: float = DEFAULT_SEGMENT_SEC) -> list[SegmentWindow]:
    """
    Plan up to three non-identical windows.

    - short track (<= segment): whole file once
    - otherwise: start, middle (centered), end
    - drop duplicates when offsets collapse on short songs
    """
    if duration_sec <= 0:
        return []

    if duration_sec <= segment_sec + 0.05:
        return [SegmentWindow("full", 0.0, duration_sec)]

    candidates = [
        SegmentWindow("start", 0.0, segment_sec),
        SegmentWindow(
            "middle",
            max(0.0, duration_sec / 2.0 - segment_sec / 2.0),
            segment_sec,
        ),
        SegmentWindow("end", max(0.0, duration_sec - segment_sec), segment_sec),
    ]

    unique: list[SegmentWindow] = []
    for win in candidates:
        if any(abs(win.offset_sec - u.offset_sec) < 0.5 for u in unique):
            continue
        unique.append(win)
    return unique


def _ffprobe_duration(path: Path) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe not found")
    out = subprocess.check_output(
        [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=30,
        stderr=subprocess.STDOUT,
    )
    return float(out.decode().strip())


def audio_duration(path: Path) -> float:
    try:
        return float(librosa.get_duration(path=str(path)))
    except Exception:
        logger.info("soundfile duration failed for %s — trying ffmpeg", path)
        return _ffprobe_duration(path)


def _ffmpeg_load_window(
    path: Path, *, sample_rate: int, offset_sec: float, duration_sec: float
) -> np.ndarray:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    cmd = [
        ffmpeg, "-nostdin", "-v", "error",
        "-ss", f"{offset_sec:.3f}",
        "-t", f"{max(duration_sec, 0.05):.3f}",
        "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(int(sample_rate)),
        "pipe:1",
    ]
    raw = subprocess.check_output(cmd, timeout=120)
    y = np.frombuffer(raw, dtype=np.float32)
    if y.size == 0:
        raise RuntimeError("ffmpeg returned empty audio")
    return y.copy()


def _load_window(
    path: Path, win: SegmentWindow, *, sample_rate: int
) -> np.ndarray | None:
    try:
        y, _ = librosa.load(
            str(path),
            sr=sample_rate,
            mono=True,
            offset=win.offset_sec,
            duration=win.duration_sec,
        )
        y = np.asarray(y, dtype=np.float32)
        if y.size:
            return y
    except Exception:
        logger.info("librosa.load failed for %s @ %.1fs — trying ffmpeg", path, win.offset_sec)
    try:
        y = _ffmpeg_load_window(
            path,
            sample_rate=sample_rate,
            offset_sec=win.offset_sec,
            duration_sec=win.duration_sec,
        )
        return y if y.size else None
    except Exception:
        logger.exception("ffmpeg load failed for %s", path)
        return None


def load_segment_audio(
    path: Path,
    *,
    sample_rate: int = DEFAULT_SR,
    segment_sec: float = DEFAULT_SEGMENT_SEC,
) -> list[tuple[SegmentWindow, np.ndarray]]:
    """Load mono float32 arrays for each planned window."""
    duration = audio_duration(path)
    windows = plan_windows(duration, segment_sec=segment_sec)
    out: list[tuple[SegmentWindow, np.ndarray]] = []
    for win in windows:
        y = _load_window(path, win, sample_rate=sample_rate)
        if y is None or y.size == 0:
            continue
        out.append((win, y))
    if not out:
        raise RuntimeError(f"не удалось декодировать аудио: {path}")
    return out
