package api

// EnsureWorker preserves the server lifecycle API while delegating process
// management to the application layer.
func (s *Server) EnsureWorker() {
	s.App.EnsureWorker()
}

// WatchJobs preserves the server lifecycle API while delegating polling to the
// application layer.
func (s *Server) WatchJobs() {
	s.App.WatchJobs()
}

func (s *Server) ensureWorkerBeforeEnqueue() {
	if !s.App.WorkerHealthy() {
		s.App.EnsureWorker()
	}
}
