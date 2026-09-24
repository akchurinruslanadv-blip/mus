package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, 400, "bad_id", "bad id")
		return
	}
	row, ok := s.Idx.RowOf(id)
	path := ""
	if ok {
		path = s.Idx.MetaAt(row).Path
	} else if p, err := s.Store.TrackPath(id); err == nil && p != "" {
		path = p
	} else {
		writeErr(w, 404, "not_found", "not found")
		return
	}
	q := strings.ToLower(r.URL.Query().Get("q"))
	if q == "" {
		q = strings.ToLower(r.URL.Query().Get("fmt"))
	}
	if q == "mobile" || q == "aac" || q == "mp3" {
		s.Media.ServeMobile(w, r, id, path)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, 404, "file_missing", "file missing")
		return
	}
	defer f.Close()
	stat, _ := f.Stat()
	w.Header().Set("Content-Type", contentType(path))
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), f)
}
