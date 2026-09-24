package apitest

import (
	"bytes"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/torwin-job/musik/player/internal/api"
	"github.com/torwin-job/musik/player/internal/config"
	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
	"github.com/torwin-job/musik/player/internal/media"
	"github.com/torwin-job/musik/player/internal/taste"
)

func openTestServer(t *testing.T) *api.Server {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "db", "musik-api-test.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	bootstrap, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE tracks (
			id INTEGER PRIMARY KEY, path TEXT NOT NULL DEFAULT '',
			title TEXT, artist TEXT, album TEXT, duration REAL,
			file_md5 TEXT, created_at TEXT,
			is_active INTEGER NOT NULL DEFAULT 1,
			is_duplicate_of INTEGER,
			artwork_path TEXT
		)`,
		`CREATE TABLE features (
			track_id INTEGER PRIMARY KEY,
			status TEXT,
			cluster_id INTEGER,
			embedding BLOB,
			embedding_dim INTEGER
		)`,
		`CREATE TABLE listening_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL,
			ts TEXT NOT NULL, source TEXT, action TEXT NOT NULL,
			daypart TEXT, weekday INTEGER, position_sec REAL, duration_sec REAL
		)`,
		`CREATE TABLE playlists (
			id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
		)`,
		`CREATE TABLE playlist_tracks (
			playlist_id INTEGER NOT NULL, position INTEGER NOT NULL,
			track_id INTEGER NOT NULL, explanation TEXT
		)`,
	} {
		if _, err := bootstrap.Exec(statement); err != nil {
			_ = bootstrap.Close()
			t.Fatalf("create test schema: %v", err)
		}
	}
	if err := bootstrap.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	cfg := config.Config{
		DBPath: path, QueueSize: 6, AuthDisabled: true,
		ProfileFormingAt: 3, ProfileReadyAt: 8, ExploreRatio: 0.15,
		DiscoverExploreRatio: 0.35, WorkerURL: "http://127.0.0.1:1",
		WorkerAutostart: false,
	}
	idx := index.New(cfg)
	rows := make([]db.TrackRow, 0, 3)
	for _, id := range []int64{11, 22, 33} {
		rows = append(rows, db.TrackRow{
			ID: id, Path: filepath.Join(dir, "missing.flac"),
			Title: "Track", Artist: "Artist", Album: "Album", Duration: 180,
			Embedding: index.Float32Bytes([]float32{1, float32(id)}), Dim: 2,
		})
		if _, err := store.DB.Exec(
			`INSERT INTO tracks(id, path, title, artist, album, duration) VALUES (?,?,?,?,?,?)`,
			id, filepath.Join(dir, "missing.flac"), "Track", "Artist", "Album", 180,
		); err != nil {
			t.Fatal(err)
		}
	}
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	server := api.New(cfg, store, idx, taste.New(), nil)
	server.Play.Warm = nil
	return server
}

func serve(server *api.Server, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	return rec
}

func jsonReq(method, path, body string) *http.Request {
	var rdr *bytes.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func flush(server *api.Server) {
	if server.Play != nil && server.Play.Flush != nil {
		server.Play.Flush()
	}
}

func loadIndex(t *testing.T, server *api.Server, rows []db.TrackRow) {
	t.Helper()
	idx := index.New(server.Cfg)
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	server.Idx = idx
	server.Media = media.New(server.Cfg, idx)
	if server.Play != nil {
		server.Play.Idx = idx
		server.Play.Warm = server.Media.Warm
	}
	if server.Builder != nil {
		server.Builder.Idx = idx
	}
}
