package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

func (s *Server) handleShareRadioCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "musik radio"
	}
	token, err := randomToken(16)
	if err != nil {
		writeErr(w, 500, "token", err.Error())
		return
	}
	sh, err := s.Store.CreateRadioShare(token, name)
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	base := s.publicBase(r)
	writeJSON(w, map[string]any{
		"ok":         true,
		"token":      sh.Token,
		"name":       sh.Name,
		"created_at": sh.CreatedAt,
		"url":        base + "/listen/" + sh.Token + ".mp3",
		"url_bare":   base + "/listen/" + sh.Token,
	})
}

func (s *Server) handleShareRadioList(w http.ResponseWriter, r *http.Request) {
	include := r.URL.Query().Get("all") == "1"
	list, err := s.Store.ListRadioShares(include)
	if err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	base := s.publicBase(r)
	type row struct {
		Token        string  `json:"token"`
		Name         string  `json:"name"`
		CreatedAt    string  `json:"created_at"`
		RevokedAt    *string `json:"revoked_at,omitempty"`
		LastListenAt *string `json:"last_listen_at,omitempty"`
		ListenCount  int     `json:"listen_count"`
		Active       bool    `json:"active"`
		URL          string  `json:"url"`
	}
	out := make([]row, 0, len(list))
	for _, sh := range list {
		out = append(out, row{
			Token: sh.Token, Name: sh.Name, CreatedAt: sh.CreatedAt,
			RevokedAt: sh.RevokedAt, LastListenAt: sh.LastListenAt,
			ListenCount: sh.ListenCount, Active: sh.Active,
			URL: base + "/listen/" + sh.Token + ".mp3",
		})
	}
	writeJSON(w, map[string]any{"shares": out, "count": len(out)})
}

func (s *Server) handleShareRadioRevoke(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.PathValue("token"))
	if token == "" {
		writeErr(w, 400, "token", "token required")
		return
	}
	if err := s.Store.RevokeRadioShare(token); err != nil {
		writeErr(w, 404, "not_found", "share not found")
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) publicBase(r *http.Request) string {
	if s.Cfg.PublicBaseURL != "" {
		return s.Cfg.PublicBaseURL
	}
	scheme := "http"
	if r.TLS != nil || s.Cfg.SecureCookie {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p == "https" || p == "http" {
		scheme = p
	}
	host := r.Host
	if host == "" {
		host = "127.0.0.1:8787"
	}
	return scheme + "://" + host
}

func randomToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
