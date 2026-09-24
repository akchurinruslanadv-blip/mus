package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleLaterList(w http.ResponseWriter, _ *http.Request) {
	tracks, err := s.Store.LaterList()
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	enriched := make([]any, 0, len(tracks))
	for _, t := range tracks {
		enriched = append(enriched, map[string]any{
			"track_id": t.TrackID, "artist": t.Artist, "title": t.Title,
			"duration": t.Duration, "position": t.Position,
			"stream": s.trackJSON(t.TrackID),
		})
	}
	writeJSON(w, map[string]any{"tracks": enriched, "count": len(tracks)})
}

func (s *Server) handleLaterAdd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TrackID int64 `json:"track_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TrackID == 0 {
		writeErr(w, 400, "track_id_required", "track_id required")
		return
	}
	if err := s.Store.LaterAdd(req.TrackID); err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "count": s.Store.LaterCount()})
}

func (s *Server) handleLaterRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TrackID int64 `json:"track_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TrackID == 0 {
		writeErr(w, 400, "track_id_required", "track_id required")
		return
	}
	if err := s.Store.LaterRemove(req.TrackID); err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "count": s.Store.LaterCount()})
}
