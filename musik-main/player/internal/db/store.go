package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

func mondayZeroWeekday(day time.Weekday) int {
	return (int(day) + 6) % 7
}

type TrackRow struct {
	ID          int64
	Path        string
	Title       string
	Artist      string
	Album       string
	Duration    float64
	FileMD5     string
	CreatedAt   string
	ArtworkPath string
	ClusterID   int
	Embedding   []byte
	Dim         int
	Shown       int
	SkipEarly   int
	Completed   int
}

func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	if err := s.ensureSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Truncate WAL so it does not grow unbounded across restarts.
	_, _ = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

func (s *Store) ensureSchema() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS rec_stats (
    track_id       INTEGER PRIMARY KEY,
    shown          INTEGER NOT NULL DEFAULT 0,
    skipped_early  INTEGER NOT NULL DEFAULT 0,
    completed      INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS recommendation_impressions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    track_id        INTEGER NOT NULL,
    position        INTEGER NOT NULL,
    score           REAL NOT NULL DEFAULT 0,
    cosine_taste    REAL NOT NULL DEFAULT 0,
    cosine_current  REAL NOT NULL DEFAULT 0,
    explore         INTEGER NOT NULL DEFAULT 0,
    new_boost       INTEGER NOT NULL DEFAULT 0,
    maturity        TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT '',
    shown_at        TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS discover_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    score REAL NOT NULL DEFAULT 0,
    track_ids_json TEXT NOT NULL,
    explanation TEXT,
    created_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS listen_later (
    track_id INTEGER PRIMARY KEY,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);`,
		`CREATE TABLE IF NOT EXISTS favorites (
    track_id INTEGER PRIMARY KEY,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);`,
		`CREATE TABLE IF NOT EXISTS favorite_artists (
    artist TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);`,
		`CREATE TABLE IF NOT EXISTS favorite_albums (
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artist, album)
);`,
		`CREATE TABLE IF NOT EXISTS radio_shares (
    token TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_listen_at TEXT,
    listen_count INTEGER NOT NULL DEFAULT 0
);`,
		`CREATE TABLE IF NOT EXISTS play_sessions (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT '',
    current_id INTEGER NOT NULL DEFAULT 0,
    queue_json TEXT,
    exclude_json TEXT,
    rated_json TEXT,
    daily_ids_json TEXT,
    daily_pos INTEGER NOT NULL DEFAULT 0,
    playlist_name TEXT NOT NULL DEFAULT '',
    playlist_kind TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS lyrics (
    track_id INTEGER PRIMARY KEY,
    plain_lyrics TEXT NOT NULL DEFAULT '',
    synced_lyrics TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    instrumental INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    updated_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);`,
		`CREATE INDEX IF NOT EXISTS idx_history_weekday_action
ON listening_history(weekday, action);`,
		`CREATE INDEX IF NOT EXISTS idx_impressions_shown_at
ON recommendation_impressions(shown_at);`,
		`CREATE INDEX IF NOT EXISTS idx_impressions_session_track
ON recommendation_impressions(session_id, track_id, shown_at);`,
		`CREATE INDEX IF NOT EXISTS idx_playlists_kind_id
ON playlists(kind, id DESC);`,
	}
	for _, q := range stmts {
		if _, err := s.DB.Exec(q); err != nil {
			return err
		}
	}
	for _, col := range []string{
		"ALTER TABLE listening_history ADD COLUMN listened_sec REAL",
		"ALTER TABLE listening_history ADD COLUMN session_id TEXT",
		"ALTER TABLE listening_history ADD COLUMN reason TEXT",
	} {
		_, _ = s.DB.Exec(col)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	res, err := tx.Exec(
		`INSERT OR IGNORE INTO schema_migrations(name, applied_at) VALUES (?, ?)`,
		"weekday_monday_zero_v1", time.Now().UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if changed, _ := res.RowsAffected(); changed > 0 {
		if _, err := tx.Exec(
			`UPDATE listening_history SET weekday = (weekday + 6) % 7
			 WHERE weekday BETWEEN 0 AND 6`,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}
