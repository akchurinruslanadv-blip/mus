package api

import (
	"net/http"
)

func (s *Server) handleArtwork(w http.ResponseWriter, r *http.Request) {
	s.Media.ServeArtwork(w, r)
}
