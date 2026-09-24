package api

import (
	"encoding/json"
	"net/http"

	"github.com/torwin-job/musik/player/internal/playback"
)

type playReq struct {
	TrackID      int64   `json:"track_id"`
	TrackIDs     []int64 `json:"track_ids"`
	Artist       string  `json:"artist"`
	Album        string  `json:"album"`
	StartIndex   *int    `json:"start_index"`
	StartTrackID int64   `json:"start_track_id"`
	Name         string  `json:"name"`
}

func (s *Server) handlePlay(w http.ResponseWriter, r *http.Request) {
	var req playReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "bad_json", "bad json")
		return
	}
	startIdx := 0
	if req.StartIndex != nil {
		startIdx = *req.StartIndex
	}
	ids, name, err := s.Play.ResolvePlayIDs(playback.PlaySpec{
		TrackID: req.TrackID, TrackIDs: req.TrackIDs,
		Artist: req.Artist, Album: req.Album, Name: req.Name,
	})
	if err != nil {
		writeErr(w, playHTTPStatus(err), "play", err.Error())
		return
	}
	sess := s.Play.StartFixed(ids, "listen", name, "listen", startIdx, req.StartTrackID)
	sess.Lock()
	defer sess.Unlock()
	writeJSON(w, s.playResponse(sess))
}
