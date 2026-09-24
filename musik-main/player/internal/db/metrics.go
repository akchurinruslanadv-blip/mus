package db

type Metrics struct {
	Listens7d       int     `json:"listens_7d"`
	Skips7d         int     `json:"skips_7d"`
	SkipRate7d      float64 `json:"skip_rate_7d"`
	Completes7d     int     `json:"completes_7d"`
	ExploreShown    int     `json:"explore_shown"`
	ExploitShown    int     `json:"exploit_shown"`
	ExploreSkips    int     `json:"explore_early_skips"`
	ExploitSkips    int     `json:"exploit_early_skips"`
	ExploreComplete int     `json:"explore_completes"`
	ExploitComplete int     `json:"exploit_completes"`
	ExploreSkipRate float64 `json:"explore_skip_rate"`
	ExploitSkipRate float64 `json:"exploit_skip_rate"`
	ExploreCompRate float64 `json:"explore_complete_rate"`
	ExploitCompRate float64 `json:"exploit_complete_rate"`
	UniqueArtists7d int     `json:"unique_artists_7d"`
}

func (s *Store) WeeklyMetrics() (Metrics, error) {
	var m Metrics
	err := s.DB.QueryRow(`
SELECT
  COALESCE(SUM(CASE WHEN action IN ('track_end','finish','skip','like') THEN 1 ELSE 0 END),0),
  COALESCE(SUM(CASE WHEN action='skip' OR (action='track_end' AND reason='skipped') THEN 1 ELSE 0 END),0),
  COALESCE(SUM(CASE WHEN action='finish' OR (action='track_end' AND reason='completed') THEN 1 ELSE 0 END),0)
FROM listening_history
WHERE ts >= datetime('now', '-7 days')`).Scan(&m.Listens7d, &m.Skips7d, &m.Completes7d)
	if err != nil {
		return m, err
	}
	if m.Listens7d > 0 {
		m.SkipRate7d = float64(m.Skips7d) / float64(m.Listens7d)
	}
	_ = s.DB.QueryRow(`
SELECT COUNT(DISTINCT t.artist)
FROM listening_history h
JOIN tracks t ON t.id = h.track_id
WHERE h.ts >= datetime('now', '-7 days')`).Scan(&m.UniqueArtists7d)
	err = s.DB.QueryRow(`
SELECT
  COALESCE(SUM(CASE WHEN i.explore = 1 THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN i.explore = 0 THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN i.explore = 1 AND EXISTS (
    SELECT 1 FROM listening_history h
    WHERE h.session_id = i.session_id AND h.track_id = i.track_id
      AND h.action = 'track_end' AND h.reason = 'skipped'
      AND COALESCE(h.listened_sec,0) < 0.3 * COALESCE(h.duration_sec,1)
      AND datetime(h.ts) >= datetime(i.shown_at)
  ) THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN i.explore = 0 AND EXISTS (
    SELECT 1 FROM listening_history h
    WHERE h.session_id = i.session_id AND h.track_id = i.track_id
      AND h.action = 'track_end' AND h.reason = 'skipped'
      AND COALESCE(h.listened_sec,0) < 0.3 * COALESCE(h.duration_sec,1)
      AND datetime(h.ts) >= datetime(i.shown_at)
  ) THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN i.explore = 1 AND EXISTS (
    SELECT 1 FROM listening_history h
    WHERE h.session_id = i.session_id AND h.track_id = i.track_id
      AND h.action = 'track_end'
      AND (h.reason = 'completed' OR COALESCE(h.listened_sec,0) >= 0.8 * COALESCE(h.duration_sec,1))
      AND datetime(h.ts) >= datetime(i.shown_at)
  ) THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN i.explore = 0 AND EXISTS (
    SELECT 1 FROM listening_history h
    WHERE h.session_id = i.session_id AND h.track_id = i.track_id
      AND h.action = 'track_end'
      AND (h.reason = 'completed' OR COALESCE(h.listened_sec,0) >= 0.8 * COALESCE(h.duration_sec,1))
      AND datetime(h.ts) >= datetime(i.shown_at)
  ) THEN 1 ELSE 0 END), 0)
FROM recommendation_impressions i
WHERE datetime(i.shown_at) >= datetime('now', '-7 days')`).Scan(
		&m.ExploreShown, &m.ExploitShown, &m.ExploreSkips, &m.ExploitSkips,
		&m.ExploreComplete, &m.ExploitComplete,
	)
	if err != nil {
		return m, err
	}
	if m.ExploreShown > 0 {
		m.ExploreSkipRate = float64(m.ExploreSkips) / float64(m.ExploreShown)
		m.ExploreCompRate = float64(m.ExploreComplete) / float64(m.ExploreShown)
	}
	if m.ExploitShown > 0 {
		m.ExploitSkipRate = float64(m.ExploitSkips) / float64(m.ExploitShown)
		m.ExploitCompRate = float64(m.ExploitComplete) / float64(m.ExploitShown)
	}
	return m, nil
}

func dayPart(h int) string {
	switch {
	case h >= 5 && h < 12:
		return "morning"
	case h >= 12 && h < 17:
		return "afternoon"
	case h >= 17 && h < 23:
		return "evening"
	default:
		return "night"
	}
}

// DayPart is the exported name for API/queue blending.
func DayPart(h int) string { return dayPart(h) }

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
