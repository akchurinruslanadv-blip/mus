from pathlib import Path
from unittest.mock import patch

import numpy as np

from musik.embed.segments import SegmentWindow, audio_duration, load_segment_audio, plan_windows


def test_short_track_one_window():
    wins = plan_windows(20.0, segment_sec=30.0)
    assert len(wins) == 1
    assert wins[0].name == "full"


def test_long_track_three_windows():
    wins = plan_windows(240.0, segment_sec=30.0)
    assert [w.name for w in wins] == ["start", "middle", "end"]
    assert wins[0].offset_sec == 0.0
    assert abs(wins[1].offset_sec - (120.0 - 15.0)) < 1e-6
    assert abs(wins[2].offset_sec - 210.0) < 1e-6


def test_medium_track_dedupes_offsets():
    # 45s → start@0, middle@7.5, end@15 — all distinct
    wins = plan_windows(45.0, segment_sec=30.0)
    assert len(wins) == 3
    # 35s → start@0, middle@2.5, end@5 — all kept (offsets differ >0.5)
    wins35 = plan_windows(35.0, segment_sec=30.0)
    assert len(wins35) >= 2


def test_audio_duration_falls_back_to_ffprobe():
    with (
        patch("musik.embed.segments.librosa.get_duration", side_effect=RuntimeError("nope")),
        patch("musik.embed.segments._ffprobe_duration", return_value=123.5) as probe,
    ):
        assert audio_duration(Path("/tmp/song.m4a")) == 123.5
        probe.assert_called_once()


def test_load_segment_audio_uses_ffmpeg_when_librosa_fails():
    fake = np.ones(48000, dtype=np.float32)
    with (
        patch("musik.embed.segments.audio_duration", return_value=20.0),
        patch("musik.embed.segments.librosa.load", side_effect=RuntimeError("format")),
        patch("musik.embed.segments._ffmpeg_load_window", return_value=fake) as ff,
    ):
        out = load_segment_audio(Path("/tmp/song.m4a"), sample_rate=48000, segment_sec=30.0)
    assert len(out) == 1
    assert out[0][0].name == "full"
    assert out[0][1] is fake
    ff.assert_called_once()
    win = ff.call_args.kwargs
    assert abs(win["duration_sec"] - 20.0) < 1e-6
