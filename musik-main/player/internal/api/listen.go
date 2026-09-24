package api

import (
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"

	"github.com/torwin-job/musik/player/internal/media"
)

// handleListenShare serves a continuous MP3 radio stream for a share token.
// Public (token is the credential). Does not update the owner's taste profile.
func (s *Server) handleListenShare(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSuffix(r.PathValue("token"), ".mp3")
	token = strings.TrimSpace(token)
	if token == "" {
		writeErr(w, 400, "token", "token required")
		return
	}
	_, ok, err := s.Store.GetActiveRadioShare(token)
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "share not found or revoked")
		return
	}
	if s.Idx.Size() == 0 {
		writeErr(w, 503, "empty", "library empty")
		return
	}
	ffmpeg := s.Cfg.FFmpegPath
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	if _, err := exec.LookPath(ffmpeg); err != nil {
		writeErr(w, 503, "ffmpeg", "ffmpeg not found — install ffmpeg or set MUSIK_FFMPEG")
		return
	}

	max := s.Cfg.ShareMaxListeners
	if max < 1 {
		max = 4
	}
	if int(atomic.LoadInt32(&s.shareListeners)) >= max {
		writeErr(w, 503, "busy", "too many share listeners")
		return
	}
	atomic.AddInt32(&s.shareListeners, 1)
	defer atomic.AddInt32(&s.shareListeners, -1)
	_ = s.Store.TouchRadioShareListen(token)

	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("icy-name", "musik radio")
	w.Header().Set("icy-genre", "Various")
	w.Header().Set("icy-pub", "0")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	sess := s.Play.StartShare()

	ctx := r.Context()
	bitrate := s.Cfg.ShareBitrate
	if bitrate == "" {
		bitrate = "192k"
	}
	for tracks := 0; tracks < 5000; tracks++ {
		if ctx.Err() != nil {
			return
		}
		id := s.Play.ShareCurrentTrackID(sess)
		path := ""
		if row, ok := s.Idx.RowOf(id); ok {
			path = s.Idx.MetaAt(row).Path
		}
		if path == "" {
			return
		}
		if _, err := os.Stat(path); err != nil {
			log.Printf("share listen: missing file id=%d", id)
			s.Play.AdvanceShare(sess)
			continue
		}
		if err := media.PipeTrackMP3(ctx, w, flusher, ffmpeg, path, bitrate); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("share listen ffmpeg: %v", err)
		}
		s.Play.AdvanceShare(sess)
	}
}
