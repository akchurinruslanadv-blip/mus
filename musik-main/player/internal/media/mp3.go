package media

import (
	"context"
	"io"
	"os/exec"
)

// Flusher flushes buffered stream data to a listener.
type Flusher interface {
	Flush()
}

// PipeTrackMP3 transcodes a track to MP3 and streams it to w.
func PipeTrackMP3(
	ctx context.Context,
	w io.Writer,
	flusher Flusher,
	ffmpeg, path, bitrate string,
) error {
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-i", path,
		"-vn",
		"-acodec", "libmp3lame",
		"-b:a", bitrate,
		"-ar", "44100",
		"-ac", "2",
		"-f", "mp3",
		"pipe:1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return err
	}
	buf := make([]byte, 32*1024)
	for {
		if ctx.Err() != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return ctx.Err()
		}
		n, readErr := stdout.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			waitErr := cmd.Wait()
			if readErr == io.EOF {
				return waitErr
			}
			return readErr
		}
	}
}
