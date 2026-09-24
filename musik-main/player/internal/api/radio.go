package api

import (
	"encoding/json"
	"net/http"
	"time"
)

func (s *Server) handleRadioStart(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	defer func() { s.latency.Observe("radio_start", time.Since(started)) }()
	var req struct {
		SeedTrackID *int64 `json:"seed_track_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	sess := s.Play.StartRadio(req.SeedTrackID)
	sess.Lock()
	defer sess.Unlock()
	writeJSON(w, s.sessionStartResponse(sess))
}
