package playback

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/torwin-job/musik/player/internal/config"
	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
	"github.com/torwin-job/musik/player/internal/queue"
	"github.com/torwin-job/musik/player/internal/taste"
)

func testEngine(t *testing.T) *Engine {
	t.Helper()
	path := filepath.Join(t.TempDir(), "playback-test.db")
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
			is_active INTEGER NOT NULL DEFAULT 1
		)`,
		`CREATE TABLE listening_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER NOT NULL,
			ts TEXT NOT NULL, source TEXT, action TEXT NOT NULL,
			daypart TEXT, weekday INTEGER, position_sec REAL, duration_sec REAL
		)`,
		`CREATE TABLE playlists (
			id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
		)`,
	} {
		if _, err := bootstrap.Exec(statement); err != nil {
			_ = bootstrap.Close()
			t.Fatal(err)
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

	cfg := config.Config{QueueSize: 6, ProfileFormingAt: 3, ProfileReadyAt: 8, ExploreRatio: 0.15}
	idx := index.New(cfg)
	rows := []db.TrackRow{
		{ID: 11, Title: "One", Artist: "Artist", Album: "Album", Embedding: index.Float32Bytes([]float32{1, 11}), Dim: 2},
		{ID: 22, Title: "Two", Artist: "Artist", Album: "Album", Embedding: index.Float32Bytes([]float32{1, 22}), Dim: 2},
		{ID: 33, Title: "Three", Artist: "Artist", Album: "Album", Embedding: index.Float32Bytes([]float32{1, 33}), Dim: 2},
	}
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	return New(cfg, store, idx, taste.New(), queue.NewBuilder(idx, cfg))
}

func TestStartFixedPreservesOrderAndStartPosition(t *testing.T) {
	tests := []struct {
		name         string
		startIndex   int
		startTrackID int64
		wantIndex    int
		wantCurrent  int64
	}{
		{name: "index", startIndex: 2, wantIndex: 2, wantCurrent: 33},
		{name: "track id overrides index", startIndex: 0, startTrackID: 22, wantIndex: 1, wantCurrent: 22},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			engine := testEngine(t)
			order := []int64{11, 22, 33}
			session := engine.StartFixed(
				append([]int64(nil), order...), "playlist", "Ordered", "daily",
				test.startIndex, test.startTrackID,
			)
			if !reflect.DeepEqual(session.DailyIDs, order) {
				t.Fatalf("session order = %v, want %v", session.DailyIDs, order)
			}
			if session.DailyPos != test.wantIndex || session.Current != test.wantCurrent {
				t.Fatalf("position/current = %d/%d, want %d/%d",
					session.DailyPos, session.Current, test.wantIndex, test.wantCurrent)
			}

			row, ok, err := engine.Store.LoadPlaySession(session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !ok {
				t.Fatal("fixed session was not persisted")
			}
			var persistedOrder []int64
			if err := json.Unmarshal([]byte(row.DailyIDsJSON), &persistedOrder); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(persistedOrder, order) {
				t.Fatalf("persisted order = %v, want %v", persistedOrder, order)
			}
			if row.DailyPos != test.wantIndex || row.CurrentID != test.wantCurrent {
				t.Fatalf("persisted position/current = %d/%d, want %d/%d",
					row.DailyPos, row.CurrentID, test.wantIndex, test.wantCurrent)
			}
		})
	}
}

func TestResolvePlayIDsByArtist(t *testing.T) {
	engine := testEngine(t)
	ids, name, err := engine.ResolvePlayIDs(PlaySpec{Artist: "Artist"})
	if err != nil {
		t.Fatal(err)
	}
	if name != "Artist" || !reflect.DeepEqual(ids, []int64{11, 22, 33}) {
		t.Fatalf("ids=%v name=%q", ids, name)
	}
}

func TestStartShareInitializesSession(t *testing.T) {
	engine := testEngine(t)

	session := engine.StartShare()
	current := engine.ShareCurrentTrackID(session)

	if session.Mode != "share" {
		t.Fatalf("mode = %q, want share", session.Mode)
	}
	if current == 0 {
		t.Fatal("current track was not selected")
	}
	if !session.Exclude[current] {
		t.Fatalf("current track %d was not excluded", current)
	}
	if len(session.Queue) == 0 {
		t.Fatal("share queue was not initialized")
	}
}

func TestAdvanceShareRestartsAfterAdvanceEnds(t *testing.T) {
	engine := testEngine(t)
	session := engine.NewSession("listen")
	session.Lock()
	session.Current = 11
	session.DailyIDs = []int64{11}
	session.DailyPos = 0
	session.Unlock()

	next := engine.AdvanceShare(session)

	if next == 0 {
		t.Fatal("share fallback did not select a track")
	}
	if session.Mode != "share" {
		t.Fatalf("mode = %q, want share", session.Mode)
	}
	if session.Current != next {
		t.Fatalf("current = %d, want %d", session.Current, next)
	}
	if !session.Exclude[next] {
		t.Fatalf("fallback track %d was not excluded", next)
	}
}
