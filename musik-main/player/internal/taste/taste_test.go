package taste

import "testing"

func TestMaturity(t *testing.T) {
	p := New()
	p.SetCounts(0, 0)
	if p.Maturity(5, 15) != StatusDiscovering {
		t.Fatal("expected discovering")
	}
	p.SetCounts(5, 0)
	if p.Maturity(5, 15) != StatusForming {
		t.Fatal("expected forming")
	}
	p.SetCounts(15, 2)
	if p.Maturity(5, 15) != StatusReady {
		t.Fatal("expected ready")
	}
}

func TestWeightSkip(t *testing.T) {
	w, a := WeightFromListen(10, 200, "skipped")
	if w >= 0 || a != "skip" {
		t.Fatalf("got %v %s", w, a)
	}
	w, a = WeightFromListen(180, 200, "completed")
	if w < 0.8 || a != "finish" {
		t.Fatalf("completed weight=%v action=%s", w, a)
	}
}

func TestEffectiveExplore(t *testing.T) {
	p := New()
	p.SetCounts(0, 0)
	e := p.EffectiveExplore(0.25, 0.55, 5, 15)
	if e < 0.5 {
		t.Fatalf("discover explore too low: %v", e)
	}
	p.SetCounts(20, 0)
	e = p.EffectiveExplore(0.25, 0.55, 5, 15)
	if e != 0.25 {
		t.Fatalf("ready explore want 0.25 got %v", e)
	}
}

func TestUpdateEMAPositiveAndNegative(t *testing.T) {
	p := New()
	p.UpdateEMA([]float32{1, 0}, LikeWeight(), 0.5)
	if !p.Ready() {
		t.Fatal("taste should be ready after first update")
	}
	pos, neg := p.Counts()
	if pos != 1 || neg != 0 {
		t.Fatalf("counts=%d/%d", pos, neg)
	}
	before := append([]float32(nil), p.Get()...)
	p.UpdateEMA([]float32{0, 1}, DislikeWeight(), 0.5)
	pos, neg = p.Counts()
	if pos != 1 || neg != 1 {
		t.Fatalf("after dislike counts=%d/%d", pos, neg)
	}
	after := p.Get()
	if after[0] == before[0] && after[1] == before[1] {
		t.Fatal("EMA should change vector")
	}
	if p.SourceName() != "online_ema" {
		t.Fatalf("source=%q", p.SourceName())
	}
}
