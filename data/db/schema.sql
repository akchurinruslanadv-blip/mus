-- Base schema for musik
CREATE TABLE IF NOT EXISTS tracks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    file_md5        TEXT,
    file_mtime      REAL,
    file_size       INTEGER,
    title           TEXT,
    artist          TEXT,
    album           TEXT,
    year            INTEGER,
    track_number    INTEGER,
    duration        REAL,
    bitrate         INTEGER,
    sample_rate     INTEGER,
    channels        INTEGER,
    fingerprint     TEXT,
    lufs            REAL,
    is_duplicate_of INTEGER REFERENCES tracks(id),
    is_active       INTEGER NOT NULL DEFAULT 1,
    artwork_path    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS genres (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS track_genres (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, genre_id)
);

CREATE TABLE IF NOT EXISTS features (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    embedding   BLOB,
    embedding_dim INTEGER,
    bpm         REAL,
    key_name    TEXT,
    mode        TEXT,
    lufs        REAL,
    cluster_id  INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending',
    error       TEXT,
    computed_at TEXT
);

CREATE TABLE IF NOT EXISTS listening_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id     INTEGER NOT NULL REFERENCES tracks(id),
    ts           TEXT NOT NULL,
    source       TEXT,
    action       TEXT NOT NULL,
    daypart      TEXT,
    weekday      INTEGER,
    position_sec REAL,
    duration_sec REAL,
    listened_sec REAL,
    session_id   TEXT,
    reason       TEXT
);

CREATE TABLE IF NOT EXISTS rec_stats (
    track_id       INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    shown          INTEGER NOT NULL DEFAULT 0,
    skipped_early  INTEGER NOT NULL DEFAULT 0,
    completed      INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_impressions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    score           REAL NOT NULL DEFAULT 0,
    cosine_taste    REAL NOT NULL DEFAULT 0,
    cosine_current  REAL NOT NULL DEFAULT 0,
    explore         INTEGER NOT NULL DEFAULT 0,
    new_boost       INTEGER NOT NULL DEFAULT 0,
    maturity        TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT '',
    shown_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transitions (
    from_id INTEGER NOT NULL REFERENCES tracks(id),
    to_id   INTEGER NOT NULL REFERENCES tracks(id),
    weight  REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    meta_json   TEXT
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    track_id    INTEGER NOT NULL REFERENCES tracks(id),
    explanation TEXT,
    PRIMARY KEY (playlist_id, position)
);

CREATE TABLE IF NOT EXISTS feature_weights (
    week_key TEXT NOT NULL,
    dim      INTEGER NOT NULL,
    weight   REAL NOT NULL,
    PRIMARY KEY (week_key, dim)
);

CREATE TABLE IF NOT EXISTS user_profile_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    context    TEXT NOT NULL,
    embedding  BLOB NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listen_later (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discover_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    score REAL NOT NULL DEFAULT 0,
    track_ids_json TEXT NOT NULL,
    explanation TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
    track_id INTEGER PRIMARY KEY,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorite_artists (
    artist TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorite_albums (
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    added_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artist, album)
);

CREATE TABLE IF NOT EXISTS radio_shares (
    token TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_listen_at TEXT,
    listen_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS play_sessions (
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
);

CREATE TABLE IF NOT EXISTS lyrics (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    plain_lyrics TEXT NOT NULL DEFAULT '',
    synced_lyrics TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    instrumental INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_md5 ON tracks(file_md5);
CREATE INDEX IF NOT EXISTS idx_tracks_fp ON tracks(fingerprint);
CREATE INDEX IF NOT EXISTS idx_tracks_active ON tracks(is_active);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
CREATE INDEX IF NOT EXISTS idx_history_ts ON listening_history(ts);
CREATE INDEX IF NOT EXISTS idx_history_weekday_action ON listening_history(weekday, action);
CREATE INDEX IF NOT EXISTS idx_impressions_shown_at ON recommendation_impressions(shown_at);
CREATE INDEX IF NOT EXISTS idx_impressions_session_track ON recommendation_impressions(session_id, track_id, shown_at);
CREATE INDEX IF NOT EXISTS idx_playlists_kind_id ON playlists(kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_discover_kind ON discover_tips(kind, created_at);
