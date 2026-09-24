package api

import (
	"strconv"

	"github.com/torwin-job/musik/player/internal/playback"
)

func (s *Server) trackJSON(id int64) any {
	if row, ok := s.Idx.RowOf(id); ok {
		m := s.Idx.MetaAt(row)
		out := map[string]any{
			"id": m.ID, "artist": m.Artist, "title": m.Title, "album": m.Album,
			"duration": m.Duration, "cluster_id": m.ClusterID, "ready": true,
			"stream": "/api/stream/" + strconv.FormatInt(m.ID, 10),
		}
		if m.ArtworkPath != "" {
			out["artwork"] = "/api/artwork/" + strconv.FormatInt(m.ID, 10)
		}
		return out
	}
	tracks, err := s.Store.ListCatalogTracks()
	if err != nil {
		return nil
	}
	for _, m := range tracks {
		if m.ID != id {
			continue
		}
		out := map[string]any{
			"id": m.ID, "artist": m.Artist, "title": m.Title, "album": m.Album,
			"duration": m.Duration, "cluster_id": m.Cluster, "ready": m.Status == "ready",
			"status": m.Status,
			"stream": "/api/stream/" + strconv.FormatInt(m.ID, 10),
		}
		if m.Artwork != "" {
			out["artwork"] = "/api/artwork/" + strconv.FormatInt(m.ID, 10)
		}
		return out
	}
	return nil
}

func (s *Server) sessionTracks(sess *playback.Session) []any {
	if sess == nil || len(sess.DailyIDs) == 0 {
		return nil
	}
	out := make([]any, 0, len(sess.DailyIDs))
	for i, id := range sess.DailyIDs {
		tj := s.trackJSON(id)
		m, ok := tj.(map[string]any)
		if !ok || m == nil {
			continue
		}
		m["position"] = i
		m["current"] = i == sess.DailyPos && sess.Current == id
		out = append(out, m)
	}
	return out
}

func (s *Server) playResponse(sess *playback.Session) map[string]any {
	return map[string]any{
		"session_id": sess.ID,
		"mode":       sess.Mode,
		"kind":       sess.PlaylistKind,
		"name":       sess.PlaylistName,
		"index":      sess.DailyPos,
		"count":      len(sess.DailyIDs),
		"current":    s.trackJSON(sess.Current),
		"queue":      sess.Queue,
		"tracks":     s.sessionTracks(sess),
		"fixed":      playback.IsFixedMode(sess.Mode),
	}
}

func (s *Server) sessionStartResponse(sess *playback.Session) map[string]any {
	return map[string]any{
		"session_id": sess.ID,
		"mode":       sess.Mode,
		"maturity":   s.Play.Maturity(),
		"current":    s.trackJSON(sess.Current),
		"queue":      sess.Queue,
	}
}
