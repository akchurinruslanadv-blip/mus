package db

import (
	"database/sql"
	"time"
)

func (s *Store) SaveProfile(context string, emb []byte) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`INSERT INTO user_profile_snapshots(context, embedding, created_at) VALUES (?,?,?)`,
		context, emb, now,
	)
	return err
}

// PruneProfiles keeps the newest keep snapshots for a context.
func (s *Store) PruneProfiles(context string, keep int) error {
	if keep < 1 {
		keep = 50
	}
	_, err := s.DB.Exec(`
DELETE FROM user_profile_snapshots
WHERE context = ? AND id NOT IN (
  SELECT id FROM user_profile_snapshots WHERE context = ?
  ORDER BY id DESC LIMIT ?
)`, context, context, keep)
	return err
}

func (s *Store) LatestProfile(context string) ([]byte, error) {
	var b []byte
	err := s.DB.QueryRow(`
SELECT embedding FROM user_profile_snapshots WHERE context = ?
ORDER BY id DESC LIMIT 1`, context).Scan(&b)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return b, err
}

// ListenSignalCounts counts positive/negative signals for maturity.
func (s *Store) ListenSignalCounts() (pos, neg int, err error) {
	err = s.DB.QueryRow(`
SELECT
  COALESCE(SUM(CASE
    WHEN action IN ('like','finish') THEN 1
    WHEN action = 'track_end' AND (reason IN ('completed','next') OR COALESCE(listened_sec,0) >= 0.8 * COALESCE(duration_sec,1)) THEN 1
    ELSE 0 END), 0),
  COALESCE(SUM(CASE
    WHEN action IN ('dislike','skip') THEN 1
    WHEN action = 'track_end' AND reason = 'skipped' AND COALESCE(listened_sec,0) < 0.3 * COALESCE(duration_sec,1) THEN 1
    ELSE 0 END), 0)
FROM listening_history`).Scan(&pos, &neg)
	return
}

type ArtistCount struct {
	Artist string `json:"artist"`
	Count  int    `json:"count"`
}

func (s *Store) TopArtists(limit int) ([]ArtistCount, error) {
	if limit < 1 {
		limit = 5
	}
	rows, err := s.DB.Query(`
SELECT COALESCE(t.artist,'(unknown)'), COUNT(*) AS c
FROM listening_history h
JOIN tracks t ON t.id = h.track_id
WHERE h.action IN ('like','finish','track_end')
  AND (h.reason IS NULL OR h.reason != 'skipped')
GROUP BY 1
ORDER BY c DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ArtistCount
	for rows.Next() {
		var a ArtistCount
		if err := rows.Scan(&a.Artist, &a.Count); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type ClusterCount struct {
	ClusterID int `json:"cluster_id"`
	Count     int `json:"count"`
}

func (s *Store) TopClusters(limit int) ([]ClusterCount, error) {
	if limit < 1 {
		limit = 5
	}
	rows, err := s.DB.Query(`
SELECT COALESCE(f.cluster_id, -1), COUNT(*) AS c
FROM listening_history h
JOIN features f ON f.track_id = h.track_id
WHERE h.action IN ('like','finish','track_end')
  AND (h.reason IS NULL OR h.reason != 'skipped')
  AND f.cluster_id IS NOT NULL
GROUP BY 1
ORDER BY c DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClusterCount
	for rows.Next() {
		var c ClusterCount
		if err := rows.Scan(&c.ClusterID, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
