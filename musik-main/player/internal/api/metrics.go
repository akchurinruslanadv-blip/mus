package api

import "net/http"

func (s *Server) handleWeeklyMetrics(w http.ResponseWriter, _ *http.Request) {
	m, err := s.Store.WeeklyMetrics()
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	writeJSON(w, m)
}

func (s *Server) handleRecommendationMetrics(w http.ResponseWriter, _ *http.Request) {
	m, err := s.Store.WeeklyMetrics()
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"window":     "7d",
		"outcomes":   m,
		"latency_ms": s.latency.Snapshot(),
	})
}
