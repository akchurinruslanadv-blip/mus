package db

import (
	"database/sql"
)

func (s *Store) LoadReadyTracks() ([]TrackRow, error) {
	rows, err := s.DB.Query(`
SELECT t.id, t.path, COALESCE(t.title,''), COALESCE(t.artist,''), COALESCE(t.album,''),
       COALESCE(t.duration,0), COALESCE(t.file_md5,''), COALESCE(t.created_at,''),
       COALESCE(t.artwork_path,''), COALESCE(f.cluster_id, -1),
       f.embedding, COALESCE(f.embedding_dim,0),
       COALESCE(rs.shown,0), COALESCE(rs.skipped_early,0), COALESCE(rs.completed,0)
FROM tracks t
JOIN features f ON f.track_id = t.id
LEFT JOIN rec_stats rs ON rs.track_id = t.id
WHERE t.is_active = 1 AND t.is_duplicate_of IS NULL
  AND f.status = 'ready' AND f.embedding IS NOT NULL
ORDER BY t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TrackRow
	for rows.Next() {
		var tr TrackRow
		if err := rows.Scan(&tr.ID, &tr.Path, &tr.Title, &tr.Artist, &tr.Album,
			&tr.Duration, &tr.FileMD5, &tr.CreatedAt, &tr.ArtworkPath, &tr.ClusterID,
			&tr.Embedding, &tr.Dim, &tr.Shown, &tr.SkipEarly, &tr.Completed); err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	return out, rows.Err()
}

type CatalogTrack struct {
	ID       int64
	Path     string
	Title    string
	Artist   string
	Album    string
	Duration float64
	Artwork  string
	Cluster  int
	Status   string
}

func (s *Store) ListCatalogTracks() ([]CatalogTrack, error) {
	rows, err := s.DB.Query(`
SELECT t.id, t.path, COALESCE(t.title,''), COALESCE(t.artist,''), COALESCE(t.album,''),
       COALESCE(t.duration,0), COALESCE(t.artwork_path,''), COALESCE(f.cluster_id, -1),
       COALESCE(f.status, 'pending')
FROM tracks t
LEFT JOIN features f ON f.track_id = t.id
WHERE t.is_active = 1 AND t.is_duplicate_of IS NULL
ORDER BY t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CatalogTrack
	for rows.Next() {
		var tr CatalogTrack
		if err := rows.Scan(&tr.ID, &tr.Path, &tr.Title, &tr.Artist, &tr.Album,
			&tr.Duration, &tr.Artwork, &tr.Cluster, &tr.Status); err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	return out, rows.Err()
}

func (s *Store) TrackPath(id int64) (string, error) {
	var path string
	err := s.DB.QueryRow(`SELECT path FROM tracks WHERE id = ? AND is_active = 1`, id).Scan(&path)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return path, err
}
