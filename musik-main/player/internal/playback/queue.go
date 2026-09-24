package playback

import (
	"math"
	"time"

	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
	"github.com/torwin-job/musik/player/internal/queue"
)

func (e *Engine) ExcludeTrack(sess *Session, trackID int64) {
	if trackID == 0 || sess == nil {
		return
	}
	if sess.Exclude == nil {
		sess.Exclude = map[int64]bool{}
	}
	for _, id := range e.Idx.CloneIDs(trackID) {
		sess.Exclude[id] = true
	}
}

func (e *Engine) SeedRadioExclude(sess *Session) {
	ids, err := e.Store.RecentTrackIDs(48, 120)
	if err != nil {
		return
	}
	for _, id := range ids {
		e.ExcludeTrack(sess, id)
	}
}

func (e *Engine) PickStart(sess *Session, seed *int64) int64 {
	var startID int64
	if seed != nil {
		startID = *seed
	} else if e.Discovering() {
		startID = e.Builder.PickRandom(sess.Exclude)
	} else {
		startID = e.pickTasteStart(sess)
	}
	if _, ok := e.Idx.RowOf(startID); !ok && e.Idx.Size() > 0 {
		startID = e.Idx.MetaAt(0).ID
	}
	return startID
}

func (e *Engine) pickTasteStart(sess *Session) int64 {
	n := e.Idx.Size()
	if n == 0 {
		return 0
	}
	recent := map[int64]bool{}
	if ids, err := e.Store.RecentTrackIDs(36, 50); err == nil {
		for _, id := range ids {
			recent[id] = true
		}
	}
	for id := range sess.Exclude {
		recent[id] = true
	}

	type pair struct {
		row int
		sim float32
	}
	if e.Builder.RandomFloat64() < 0.12 && n > 8 {
		if id := e.Builder.PickRandom(recent); id != 0 {
			return id
		}
	}

	k := 20
	top := e.Idx.TopK(e.tasteForQueue(), k, nil)
	if len(top) == 0 {
		return e.Builder.PickRandom(recent)
	}
	candidates := make([]pair, 0, len(top))
	for _, p := range top {
		id := e.Idx.MetaAt(p.Row).ID
		sim := p.Score
		if recent[id] {
			sim -= 0.35
		}
		candidates = append(candidates, pair{p.Row, sim})
	}
	allRecent := true
	for _, p := range candidates {
		if !recent[e.Idx.MetaAt(p.row).ID] {
			allRecent = false
			break
		}
	}
	if allRecent {
		candidates = candidates[:0]
		for _, p := range top {
			candidates = append(candidates, pair{p.Row, p.Score})
		}
	}

	const temp = 0.08
	weights := make([]float64, len(candidates))
	var sum float64
	maxSim := candidates[0].sim
	for i, p := range candidates {
		w := math.Exp(float64(p.sim-maxSim) / temp)
		weights[i] = w
		sum += w
	}
	if sum <= 0 {
		return e.Idx.MetaAt(candidates[0].row).ID
	}
	r := e.Builder.RandomFloat64() * sum
	for i, w := range weights {
		r -= w
		if r <= 0 {
			return e.Idx.MetaAt(candidates[i].row).ID
		}
	}
	return e.Idx.MetaAt(candidates[len(candidates)-1].row).ID
}

func (e *Engine) tasteForQueue() []float32 {
	g := e.Taste.Get()
	if len(g) == 0 {
		return g
	}
	dp := db.DayPart(time.Now().Hour())
	blob, err := e.Store.LatestProfile(dp)
	if err != nil || len(blob) == 0 {
		return g
	}
	d := index.BytesToFloat32(blob)
	if len(d) != len(g) {
		return g
	}
	out := make([]float32, len(g))
	for i := range g {
		out[i] = 0.7*g[i] + 0.3*d[i]
	}
	index.Normalize(out)
	return out
}

func (e *Engine) transitionsFrom(currentID int64) map[int64]float64 {
	e.transMu.RLock()
	defer e.transMu.RUnlock()
	if e.transitions == nil {
		return nil
	}
	src := e.transitions[currentID]
	if len(src) == 0 {
		return nil
	}
	out := make(map[int64]float64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func (e *Engine) RefreshQueue(sess *Session, currentID int64, countImpressions bool) {
	started := time.Now()
	defer func() { e.observe("queue_build", time.Since(started)) }()
	opts := queue.BuildOpts{
		ExploreRatio:    e.Explore(),
		Discover:        e.Discovering(),
		TransitionsFrom: e.transitionsFrom(currentID),
	}
	sess.Queue = e.Builder.BuildOpts(currentID, e.tasteForQueue(), sess.Exclude, opts)
	sess.LastQueueAt = time.Now()
	sess.UpdatedAt = time.Now()
	e.persistLocked(sess)
	e.warm(sess)
	if !countImpressions {
		return
	}
	impressions := make([]db.RecommendationImpression, 0, len(sess.Queue))
	maturity := e.Maturity()
	for position, q := range sess.Queue {
		impressions = append(impressions, db.RecommendationImpression{
			SessionID: sess.ID, TrackID: q.TrackID, Position: position,
			Score: q.Score, CosineTaste: q.CosineTaste, CosineCurrent: q.CosineCur,
			Explore: q.Explore, NewBoost: q.NewBoost, Maturity: maturity, Mode: sess.Mode,
		})
		e.Idx.BumpShownLocal(q.TrackID)
	}
	e.enqueue(func() {
		_ = e.Store.InsertRecommendationImpressions(impressions)
	})
}

func (e *Engine) RebuildFixedQueue(sess *Session) {
	sess.Queue = nil
	limit := e.Cfg.QueueSize
	if IsFixedMode(sess.Mode) {
		limit = 50
	}
	for i := sess.DailyPos + 1; i < len(sess.DailyIDs) && len(sess.Queue) < limit; i++ {
		id := sess.DailyIDs[i]
		row, ok := e.Idx.RowOf(id)
		if !ok {
			continue
		}
		m := e.Idx.MetaAt(row)
		label := sess.PlaylistName
		if label == "" {
			label = "плейлист"
		}
		sess.Queue = append(sess.Queue, queue.Item{
			TrackID: m.ID, Artist: m.Artist, Title: m.Title, Album: m.Album,
			Path: m.Path, Duration: m.Duration, Explanation: label,
		})
	}
	e.persistLocked(sess)
	e.warm(sess)
}

func (e *Engine) Advance(sess *Session) int64 {
	nextID := int64(0)
	if len(sess.DailyIDs) > 0 {
		sess.DailyPos++
		if sess.DailyPos < len(sess.DailyIDs) {
			nextID = sess.DailyIDs[sess.DailyPos]
			sess.Prev = sess.Current
			sess.Current = nextID
			e.ExcludeTrack(sess, nextID)
			e.RebuildFixedQueue(sess)
			sess.UpdatedAt = time.Now()
			e.persistLocked(sess)
			e.warm(sess)
			return nextID
		}
		if IsFixedMode(sess.Mode) {
			sess.DailyPos = len(sess.DailyIDs) - 1
			sess.Queue = nil
			sess.UpdatedAt = time.Now()
			e.persistLocked(sess)
			return 0
		}
		sess.DailyIDs = nil
		sess.Mode = "radio"
	}
	if len(sess.Queue) > 0 {
		nextID = sess.Queue[0].TrackID
		sess.Queue = sess.Queue[1:]
	} else if sess.Mode == "radio" || sess.Mode == "session" || sess.Mode == "share" {
		nextID = e.Builder.PickRandom(sess.Exclude)
	}
	sess.Prev = sess.Current
	if nextID != 0 {
		sess.Current = nextID
		e.ExcludeTrack(sess, nextID)
		if len(sess.Queue) < e.Cfg.QueueSize/2 {
			e.RefreshQueue(sess, nextID, true)
		} else {
			sess.UpdatedAt = time.Now()
			e.persistLocked(sess)
			e.warm(sess)
		}
	} else {
		sess.UpdatedAt = time.Now()
		e.persistLocked(sess)
	}
	return nextID
}

func (e *Engine) PersistTaste(trackVec []float32, signed, alpha float64) {
	blob := index.Float32Bytes(e.Taste.Get())
	_ = e.Store.SaveProfile("global", blob)
	_ = e.Store.PruneProfiles("global", 50)

	dp := db.DayPart(time.Now().Hour())
	prev, err := e.Store.LatestProfile(dp)
	if err != nil || len(prev) == 0 || len(trackVec) == 0 {
		_ = e.Store.SaveProfile(dp, blob)
		_ = e.Store.PruneProfiles(dp, 50)
		return
	}
	v := index.BytesToFloat32(prev)
	if len(v) != len(trackVec) {
		_ = e.Store.SaveProfile(dp, blob)
		_ = e.Store.PruneProfiles(dp, 50)
		return
	}
	a := float32(alpha)
	if a <= 0 {
		a = 0.1
	}
	w := float32(signed)
	for i := range v {
		v[i] = (1-a)*v[i] + a*w*trackVec[i]
	}
	index.Normalize(v)
	_ = e.Store.SaveProfile(dp, index.Float32Bytes(v))
	_ = e.Store.PruneProfiles(dp, 50)
}
