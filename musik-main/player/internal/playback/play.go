package playback

import (
	"fmt"
	"strings"
)

type PlaySpec struct {
	TrackID      int64
	TrackIDs     []int64
	Artist       string
	Album        string
	Name         string
	StartIndex   int
	StartTrackID int64
}

func IsFixedMode(mode string) bool {
	switch mode {
	case "playlist", "later", "daily", "listen", "favorites":
		return true
	default:
		return false
	}
}

func (e *Engine) ResolvePlayIDs(spec PlaySpec) (ids []int64, name string, err error) {
	if len(spec.TrackIDs) > 0 {
		for _, id := range spec.TrackIDs {
			if _, ok := e.Idx.RowOf(id); ok {
				ids = append(ids, id)
			}
		}
		name = spec.Name
		if name == "" {
			name = "Плейлист"
		}
		if len(ids) == 0 {
			return nil, "", fmt.Errorf("нет доступных треков")
		}
		return ids, name, nil
	}

	artist := strings.TrimSpace(spec.Artist)
	album := strings.TrimSpace(spec.Album)
	if artist != "" || album != "" {
		n := e.Idx.Size()
		for i := 0; i < n; i++ {
			m := e.Idx.MetaAt(i)
			if artist != "" && !strings.EqualFold(strings.TrimSpace(m.Artist), artist) {
				continue
			}
			if album != "" && !strings.EqualFold(strings.TrimSpace(m.Album), album) {
				continue
			}
			ids = append(ids, m.ID)
		}
		if len(ids) == 0 {
			return nil, "", fmt.Errorf("ничего не найдено")
		}
		switch {
		case artist != "" && album != "":
			name = artist + " — " + album
		case album != "":
			name = album
		default:
			name = artist
		}
		if spec.Name != "" {
			name = spec.Name
		}
		return ids, name, nil
	}

	if spec.TrackID != 0 {
		if _, ok := e.Idx.RowOf(spec.TrackID); !ok {
			path, err := e.Store.TrackPath(spec.TrackID)
			if err != nil || path == "" {
				return nil, "", fmt.Errorf("track not found")
			}
		}
		name = spec.Name
		if name == "" {
			name = "Трек"
		}
		return []int64{spec.TrackID}, name, nil
	}
	return nil, "", fmt.Errorf("укажи track_id, track_ids, artist или album")
}

func (e *Engine) StartFixed(ids []int64, mode, name, kind string, startIndex int, startTrackID int64) *Session {
	pos := 0
	if startTrackID != 0 {
		for i, id := range ids {
			if id == startTrackID {
				pos = i
				break
			}
		}
	} else if startIndex >= 0 && startIndex < len(ids) {
		pos = startIndex
	}
	sess := e.NewSession(mode)
	sess.Lock()
	sess.DailyIDs = ids
	sess.DailyPos = pos
	sess.PlaylistName = name
	sess.PlaylistKind = kind
	sess.Current = ids[pos]
	e.ExcludeTrack(sess, sess.Current)
	e.RebuildFixedQueue(sess)
	sess.Unlock()
	e.flush()
	return sess
}

func (e *Engine) Jump(sess *Session, index *int, trackID int64) error {
	if len(sess.DailyIDs) == 0 {
		return fmt.Errorf("нечего переключать — это не плейлист")
	}
	pos := -1
	if index != nil {
		pos = *index
	} else if trackID != 0 {
		for i, id := range sess.DailyIDs {
			if id == trackID {
				pos = i
				break
			}
		}
	}
	if pos < 0 || pos >= len(sess.DailyIDs) {
		return fmt.Errorf("track not in playlist")
	}
	sess.DailyPos = pos
	sess.Current = sess.DailyIDs[pos]
	e.ExcludeTrack(sess, sess.Current)
	e.RebuildFixedQueue(sess)
	return nil
}

func (e *Engine) StartRadio(seed *int64) *Session {
	sess := e.NewSession("radio")
	sess.Lock()
	e.SeedRadioExclude(sess)
	startID := e.PickStart(sess, seed)
	sess.Current = startID
	sess.Prev = 0
	e.ExcludeTrack(sess, startID)
	e.RefreshQueue(sess, startID, true)
	sess.Unlock()
	return sess
}

func (e *Engine) StartSession(seed *int64) *Session {
	sess := e.NewSession("session")
	sess.Lock()
	startID := e.PickStart(sess, seed)
	sess.Current = startID
	sess.Prev = 0
	e.RefreshQueue(sess, startID, true)
	sess.Unlock()
	return sess
}
