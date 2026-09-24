package db

import (
	"fmt"
	"time"
)

// RecentTrackIDs returns distinct track ids heard in the last hours (most recent first).
func (s *Store) RecentTrackIDs(hours int, limit int) ([]int64, error) {
	if hours < 1 {
		hours = 24
	}
	if limit < 1 {
		limit = 40
	}
	rows, err := s.DB.Query(`
SELECT track_id FROM (
  SELECT track_id, MAX(ts) AS last_ts
  FROM listening_history
  WHERE ts >= datetime('now', ?)
  GROUP BY track_id
  ORDER BY last_ts DESC
  LIMIT ?
)`, fmt.Sprintf("-%d hours", hours), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) InsertListen(trackID int64, action, source, sessionID, reason string,
	position, duration, listened *float64) (int64, error) {
	now := time.Now().UTC()
	daypart := dayPart(now.Hour())
	res, err := s.DB.Exec(`
INSERT INTO listening_history(
  track_id, ts, source, action, daypart, weekday,
  position_sec, duration_sec, listened_sec, session_id, reason
) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		trackID, now.Format(time.RFC3339Nano), source, action, daypart,
		mondayZeroWeekday(now.Weekday()),
		position, duration, listened, nullStr(sessionID), nullStr(reason),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) BumpTransition(fromID, toID int64, weight float64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(`
INSERT INTO transitions(from_id, to_id, weight, updated_at) VALUES (?,?,?,?)
ON CONFLICT(from_id, to_id) DO UPDATE SET
  weight = weight + excluded.weight,
  updated_at = excluded.updated_at`, fromID, toID, weight, now)
	return err
}

func (s *Store) BumpRecStats(trackID int64, shown, skipEarly, completed int) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(`
INSERT INTO rec_stats(track_id, shown, skipped_early, completed, updated_at)
VALUES (?,?,?,?,?)
ON CONFLICT(track_id) DO UPDATE SET
  shown = shown + excluded.shown,
  skipped_early = skipped_early + excluded.skipped_early,
  completed = completed + excluded.completed,
  updated_at = excluded.updated_at`,
		trackID, shown, skipEarly, completed, now)
	return err
}

type RecommendationImpression struct {
	SessionID     string
	TrackID       int64
	Position      int
	Score         float64
	CosineTaste   float64
	CosineCurrent float64
	Explore       bool
	NewBoost      bool
	Maturity      string
	Mode          string
}

// InsertRecommendationImpressions records one visible queue in a single transaction.
func (s *Store) InsertRecommendationImpressions(items []RecommendationImpression) error {
	if len(items) == 0 {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`
INSERT INTO recommendation_impressions(
  session_id, track_id, position, score, cosine_taste, cosine_current,
  explore, new_boost, maturity, mode, shown_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer stmt.Close()
	statsStmt, err := tx.Prepare(`
INSERT INTO rec_stats(track_id, shown, skipped_early, completed, updated_at)
VALUES (?,1,0,0,?)
ON CONFLICT(track_id) DO UPDATE SET
  shown = shown + 1,
  updated_at = excluded.updated_at`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer statsStmt.Close()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, item := range items {
		if _, err := stmt.Exec(
			item.SessionID, item.TrackID, item.Position, item.Score,
			item.CosineTaste, item.CosineCurrent, item.Explore, item.NewBoost,
			item.Maturity, item.Mode, now,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := statsStmt.Exec(item.TrackID, now); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
