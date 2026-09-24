package playback

import (
	"time"

	"github.com/torwin-job/musik/player/internal/taste"
)

type Event struct {
	Type        string   `json:"type"`
	TrackID     int64    `json:"track_id"`
	SessionID   string   `json:"session_id"`
	PositionSec *float64 `json:"position_sec"`
	DurationSec *float64 `json:"duration_sec"`
	ListenedSec *float64 `json:"listened_sec"`
	Reason      string   `json:"reason"`
}

type EventResult struct {
	OK           bool
	Unknown      bool
	Ignored      bool
	IgnoreReason string
	Rating       string
	Flipped      bool
	SignedWeight float64
	NextID       int64
	Ended        bool
	IsEnd        bool
	IsRate       bool
}

func (e *Engine) ApplyEvent(sess *Session, ev Event) EventResult {
	ev.SessionID = sess.ID
	switch ev.Type {
	case "track_start":
		if sess.Current != 0 && sess.Current != ev.TrackID {
			sess.Prev = sess.Current
		}
		sess.Current = ev.TrackID
		e.ExcludeTrack(sess, ev.TrackID)
		_, _ = e.Store.InsertListen(ev.TrackID, "start", "player", ev.SessionID, "",
			ev.PositionSec, ev.DurationSec, nil)
		if sess.Prev != 0 && sess.Prev != ev.TrackID {
			_ = e.Store.BumpTransition(sess.Prev, ev.TrackID, 1.0)
			e.BumpTransitionMem(sess.Prev, ev.TrackID, 1.0)
		}
		if len(sess.DailyIDs) == 0 && len(sess.Queue) < e.Cfg.QueueSize/2 {
			e.RefreshQueue(sess, ev.TrackID, true)
		}
		return EventResult{OK: true}

	case "progress":
		if sess.LastProgressWrite.IsZero() ||
			time.Since(sess.LastProgressWrite) >= 45*time.Second {
			_, _ = e.Store.InsertListen(ev.TrackID, "progress", "player", ev.SessionID, "",
				ev.PositionSec, ev.DurationSec, ev.ListenedSec)
			sess.LastProgressWrite = time.Now()
		}
		if len(sess.DailyIDs) == 0 &&
			sess.Current != 0 &&
			len(sess.Queue) < e.Cfg.QueueSize/2 &&
			time.Since(sess.LastQueueAt) >= 15*time.Second {
			e.RefreshQueue(sess, sess.Current, false)
		}
		return EventResult{OK: true}

	case "track_end", "skip":
		reason := ev.Reason
		if ev.Type == "skip" && reason == "" {
			reason = "skipped"
		}
		listened := 0.0
		if ev.ListenedSec != nil {
			listened = *ev.ListenedSec
		} else if ev.PositionSec != nil {
			listened = *ev.PositionSec
		}
		dur := 0.0
		if ev.DurationSec != nil {
			dur = *ev.DurationSec
		} else if row, ok := e.Idx.RowOf(ev.TrackID); ok {
			dur = e.Idx.MetaAt(row).Duration
		}
		_, _ = e.Store.InsertListen(ev.TrackID, "track_end", "player", ev.SessionID, reason,
			ev.PositionSec, ev.DurationSec, &listened)
		signed, _ := taste.WeightFromListen(listened, dur, reason)
		if row, ok := e.Idx.RowOf(ev.TrackID); ok && signed != 0 {
			e.Taste.UpdateEMA(e.Idx.Vector(row), signed, e.Cfg.TasteAlpha)
			e.PersistTaste(e.Idx.Vector(row), signed, e.Cfg.TasteAlpha)
		}
		if reason == "skipped" && dur > 0 && listened/dur < 0.3 {
			_ = e.Store.BumpRecStats(ev.TrackID, 0, 1, 0)
			e.Idx.BumpSkipEarlyLocal(ev.TrackID)
		}
		if reason == "completed" || (dur > 0 && listened/dur >= 0.8) {
			_ = e.Store.BumpRecStats(ev.TrackID, 0, 0, 1)
			e.Idx.BumpCompletedLocal(ev.TrackID)
		}
		e.ExcludeTrack(sess, ev.TrackID)
		nextID := e.Advance(sess)
		return EventResult{
			OK: true, IsEnd: true, SignedWeight: signed,
			NextID: nextID, Ended: nextID == 0,
		}

	case "like", "dislike":
		if sess.Rated == nil {
			sess.Rated = map[int64]string{}
		}
		prev := sess.Rated[ev.TrackID]
		if prev == ev.Type {
			return EventResult{
				OK: true, IsRate: true, Ignored: true,
				IgnoreReason: "already_" + ev.Type, Rating: prev,
			}
		}
		wSign := taste.LikeWeight()
		if ev.Type == "dislike" {
			wSign = taste.DislikeWeight()
		}
		if prev != "" {
			undo := taste.DislikeWeight()
			if prev == "dislike" {
				undo = taste.LikeWeight()
			}
			if row, ok := e.Idx.RowOf(ev.TrackID); ok {
				vec := e.Idx.Vector(row)
				e.Taste.UpdateEMA(vec, undo, e.Cfg.TasteAlpha)
				e.PersistTaste(vec, undo, e.Cfg.TasteAlpha)
			}
		}
		_, _ = e.Store.InsertListen(ev.TrackID, ev.Type, "player", ev.SessionID, "",
			nil, nil, nil)
		if row, ok := e.Idx.RowOf(ev.TrackID); ok {
			vec := e.Idx.Vector(row)
			e.Taste.UpdateEMA(vec, wSign, e.Cfg.TasteAlpha)
			e.PersistTaste(vec, wSign, e.Cfg.TasteAlpha)
		}
		sess.Rated[ev.TrackID] = ev.Type
		if len(sess.DailyIDs) == 0 {
			e.RefreshQueue(sess, sess.Current, true)
		}
		return EventResult{
			OK: true, IsRate: true, Rating: ev.Type, Flipped: prev != "",
		}

	default:
		return EventResult{Unknown: true}
	}
}
