package api

import (
	"sort"
	"sync"
	"time"
)

const latencyWindow = 1024

type latencySeries struct {
	values []float64
	next   int
	total  uint64
}

type latencyRecorder struct {
	mu     sync.Mutex
	series map[string]*latencySeries
}

type latencySummary struct {
	Count uint64  `json:"count"`
	P50MS float64 `json:"p50_ms"`
	P95MS float64 `json:"p95_ms"`
	P99MS float64 `json:"p99_ms"`
}

func newLatencyRecorder() *latencyRecorder {
	return &latencyRecorder{series: map[string]*latencySeries{}}
}

func (r *latencyRecorder) Observe(operation string, elapsed time.Duration) {
	if r == nil || operation == "" {
		return
	}
	ms := float64(elapsed.Microseconds()) / 1000
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.series[operation]
	if s == nil {
		s = &latencySeries{values: make([]float64, 0, latencyWindow)}
		r.series[operation] = s
	}
	s.total++
	if len(s.values) < latencyWindow {
		s.values = append(s.values, ms)
		return
	}
	s.values[s.next] = ms
	s.next = (s.next + 1) % latencyWindow
}

func (r *latencyRecorder) Snapshot() map[string]latencySummary {
	if r == nil {
		return map[string]latencySummary{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]latencySummary, len(r.series))
	for name, s := range r.series {
		values := append([]float64(nil), s.values...)
		sort.Float64s(values)
		out[name] = latencySummary{
			Count: s.total,
			P50MS: percentile(values, 0.50),
			P95MS: percentile(values, 0.95),
			P99MS: percentile(values, 0.99),
		}
	}
	return out
}

func percentile(values []float64, q float64) float64 {
	if len(values) == 0 {
		return 0
	}
	pos := q * float64(len(values)-1)
	lo := int(pos)
	hi := lo + 1
	if hi >= len(values) {
		return values[lo]
	}
	frac := pos - float64(lo)
	return values[lo]*(1-frac) + values[hi]*frac
}
