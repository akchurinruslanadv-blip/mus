package playback

import (
	"sync"
	"time"

	"github.com/torwin-job/musik/player/internal/config"
	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
	"github.com/torwin-job/musik/player/internal/queue"
	"github.com/torwin-job/musik/player/internal/taste"
)

type Engine struct {
	Cfg     config.Config
	Store   *db.Store
	Idx     *index.Index
	Taste   *taste.Profile
	Builder *queue.Builder

	Enqueue func(func())
	Flush   func()
	Observe func(string, time.Duration)
	Warm    func(*Session)

	sessionsMu  sync.RWMutex
	sessions    map[string]*Session
	transMu     sync.RWMutex
	transitions map[int64]map[int64]float64
}

func New(cfg config.Config, store *db.Store, idx *index.Index, tp *taste.Profile, builder *queue.Builder) *Engine {
	return &Engine{
		Cfg: cfg, Store: store, Idx: idx, Taste: tp, Builder: builder,
		sessions: map[string]*Session{},
	}
}

func (e *Engine) enqueue(work func()) {
	if work == nil {
		return
	}
	if e.Enqueue != nil {
		e.Enqueue(work)
		return
	}
	work()
}

func (e *Engine) flush() {
	if e.Flush != nil {
		e.Flush()
	}
}

func (e *Engine) observe(op string, d time.Duration) {
	if e.Observe != nil {
		e.Observe(op, d)
	}
}

func (e *Engine) warm(sess *Session) {
	if e.Warm != nil {
		e.Warm(sess)
	}
}

func (e *Engine) Maturity() string {
	return e.Taste.Maturity(e.Cfg.ProfileFormingAt, e.Cfg.ProfileReadyAt)
}

func (e *Engine) Discovering() bool {
	return e.Maturity() == taste.StatusDiscovering
}

func (e *Engine) Explore() float64 {
	return e.Taste.EffectiveExplore(e.Cfg.ExploreRatio, e.Cfg.DiscoverExploreRatio,
		e.Cfg.ProfileFormingAt, e.Cfg.ProfileReadyAt)
}

func (e *Engine) SessionCount() int {
	e.sessionsMu.RLock()
	defer e.sessionsMu.RUnlock()
	return len(e.sessions)
}

func (e *Engine) ReloadTransitions() {
	g, err := e.Store.LoadTransitionGraph()
	if err != nil {
		return
	}
	e.transMu.Lock()
	e.transitions = g
	e.transMu.Unlock()
}

func (e *Engine) BumpTransitionMem(from, to int64, w float64) {
	if from == 0 || to == 0 {
		return
	}
	e.transMu.Lock()
	defer e.transMu.Unlock()
	if e.transitions == nil {
		e.transitions = map[int64]map[int64]float64{}
	}
	m := e.transitions[from]
	if m == nil {
		m = map[int64]float64{}
		e.transitions[from] = m
	}
	m[to] += w
}
