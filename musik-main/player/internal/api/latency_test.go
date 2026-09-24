package api

import (
	"testing"
	"time"
)

func TestLatencyRecorderSummarizesBoundedWindow(t *testing.T) {
	recorder := newLatencyRecorder()
	for i := 1; i <= 100; i++ {
		recorder.Observe("queue_build", time.Duration(i)*time.Millisecond)
	}
	summary := recorder.Snapshot()["queue_build"]
	if summary.Count != 100 {
		t.Fatalf("count=%d, want 100", summary.Count)
	}
	if summary.P50MS < 49 || summary.P50MS > 51 {
		t.Fatalf("p50=%f, want about 50ms", summary.P50MS)
	}
	if summary.P95MS < 94 || summary.P95MS > 96 {
		t.Fatalf("p95=%f, want about 95ms", summary.P95MS)
	}
	if summary.P99MS < 98 || summary.P99MS > 100 {
		t.Fatalf("p99=%f, want about 99ms", summary.P99MS)
	}
}

func TestLatencyRecorderRingBufferKeepsLatestWindow(t *testing.T) {
	recorder := newLatencyRecorder()
	for i := 0; i < latencyWindow+50; i++ {
		recorder.Observe("queue_build", time.Duration(i)*time.Millisecond)
	}
	summary := recorder.Snapshot()["queue_build"]
	if summary.Count != uint64(latencyWindow+50) {
		t.Fatalf("count=%d, want %d", summary.Count, latencyWindow+50)
	}
	// Window holds the newest latencyWindow samples: [50 .. 1073] ms.
	if summary.P50MS < 550 || summary.P50MS > 575 {
		t.Fatalf("p50=%f, want ~562ms from latest window", summary.P50MS)
	}
}

func TestLatencyRecorderNilSafe(t *testing.T) {
	var recorder *latencyRecorder
	recorder.Observe("x", time.Millisecond)
	if got := recorder.Snapshot(); len(got) != 0 {
		t.Fatalf("nil snapshot=%v, want empty", got)
	}
}
