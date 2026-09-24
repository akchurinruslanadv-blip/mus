package api

import (
	"net/http"
)

func (s *Server) handleDiscoverAlbums(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"tips": s.enrichTips("new_album")})
}

func (s *Server) handleDiscoverResurfaced(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"tips": s.enrichTips("resurfaced")})
}

func (s *Server) enrichTips(kind string) []map[string]any {
	tips, err := s.Store.ListDiscoverTips(kind, 20)
	if err != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(tips))
	for _, t := range tips {
		tracks := make([]any, 0, len(t.TrackIDs))
		for _, id := range t.TrackIDs {
			tracks = append(tracks, s.trackJSON(id))
		}
		out = append(out, map[string]any{
			"id": t.ID, "kind": t.Kind, "artist": t.Artist, "album": t.Album,
			"score": t.Score, "explanation": t.Explanation, "created_at": t.CreatedAt,
			"track_ids": t.TrackIDs, "tracks": tracks,
		})
	}
	return out
}
