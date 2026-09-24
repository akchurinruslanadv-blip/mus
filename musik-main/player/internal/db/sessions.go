package db

import (
	"database/sql"
	"time"
)

// LoadTransitionGraph loads from→to weights (min weight 1).
func (s *Store) LoadTransitionGraph() (map[int64]map[int64]float64, error) {
	rows, err := s.DB.Query(`
SELECT from_id, to_id, weight FROM transitions WHERE weight >= 1
ORDER BY weight DESC LIMIT 50000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]map[int64]float64{}
	for rows.Next() {
		var from, to int64
		var w float64
		if err := rows.Scan(&from, &to, &w); err != nil {
			return nil, err
		}
		m := out[from]
		if m == nil {
			m = map[int64]float64{}
			out[from] = m
		}
		m[to] = w
	}
	return out, rows.Err()
}

type PlaySessionRow struct {
	ID           string
	Mode         string
	CurrentID    int64
	QueueJSON    string
	ExcludeJSON  string
	RatedJSON    string
	DailyIDsJSON string
	DailyPos     int
	PlaylistName string
	PlaylistKind string
	UpdatedAt    string
}

func (s *Store) UpsertPlaySession(row PlaySessionRow) error {
	_, err := s.DB.Exec(`
INSERT INTO play_sessions(
  id, mode, current_id, queue_json, exclude_json, rated_json,
  daily_ids_json, daily_pos, playlist_name, playlist_kind, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  mode=excluded.mode,
  current_id=excluded.current_id,
  queue_json=excluded.queue_json,
  exclude_json=excluded.exclude_json,
  rated_json=excluded.rated_json,
  daily_ids_json=excluded.daily_ids_json,
  daily_pos=excluded.daily_pos,
  playlist_name=excluded.playlist_name,
  playlist_kind=excluded.playlist_kind,
  updated_at=excluded.updated_at`,
		row.ID, row.Mode, row.CurrentID, nullStr(row.QueueJSON), nullStr(row.ExcludeJSON),
		nullStr(row.RatedJSON), nullStr(row.DailyIDsJSON), row.DailyPos,
		row.PlaylistName, row.PlaylistKind, row.UpdatedAt)
	return err
}

func (s *Store) LoadPlaySession(id string) (PlaySessionRow, bool, error) {
	var row PlaySessionRow
	var q, ex, rated, daily sql.NullString
	err := s.DB.QueryRow(`
SELECT id, mode, current_id, queue_json, exclude_json, rated_json,
       daily_ids_json, daily_pos, playlist_name, playlist_kind, updated_at
FROM play_sessions WHERE id = ?`, id).Scan(
		&row.ID, &row.Mode, &row.CurrentID, &q, &ex, &rated, &daily,
		&row.DailyPos, &row.PlaylistName, &row.PlaylistKind, &row.UpdatedAt)
	if err == sql.ErrNoRows {
		return PlaySessionRow{}, false, nil
	}
	if err != nil {
		return PlaySessionRow{}, false, err
	}
	if q.Valid {
		row.QueueJSON = q.String
	}
	if ex.Valid {
		row.ExcludeJSON = ex.String
	}
	if rated.Valid {
		row.RatedJSON = rated.String
	}
	if daily.Valid {
		row.DailyIDsJSON = daily.String
	}
	return row, true, nil
}

func (s *Store) DeletePlaySession(id string) error {
	_, err := s.DB.Exec(`DELETE FROM play_sessions WHERE id = ?`, id)
	return err
}

func (s *Store) DeleteStalePlaySessions(olderThan time.Time) error {
	_, err := s.DB.Exec(`DELETE FROM play_sessions WHERE updated_at < ?`, olderThan.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) CountPlaySessions() (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM play_sessions`).Scan(&n)
	return n, err
}

func (s *Store) OldestPlaySessionIDs(limit int) ([]string, error) {
	rows, err := s.DB.Query(`SELECT id FROM play_sessions ORDER BY updated_at ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
