package index

import (
	"sort"
	"testing"

	"github.com/torwin-job/musik/player/internal/config"
	"github.com/torwin-job/musik/player/internal/db"
)

func testIndex(t *testing.T) *Index {
	t.Helper()
	idx := New(config.Config{})
	rows := []db.TrackRow{
		{ID: 10, Artist: "Artist A", Album: "First", Title: "A1", Embedding: Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 11, Artist: "Artist A", Album: "First", Title: "A2", Embedding: Float32Bytes([]float32{0.8, 0.2}), Dim: 2},
		{ID: 12, Artist: "Artist B", Album: "Second", Title: "B1", Embedding: Float32Bytes([]float32{0, 1}), Dim: 2},
		{ID: 13, Artist: "Artist C", Album: "Second", Title: "C1", Embedding: Float32Bytes([]float32{-1, 0}), Dim: 2},
	}
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	return idx
}

func TestTopKMatchesFullSortAndExcludes(t *testing.T) {
	idx := testIndex(t)
	query := []float32{1, 0}
	sims := idx.SimsTo(query)
	type pair struct {
		row   int
		score float32
	}
	var want []pair
	for row, score := range sims {
		if idx.MetaAt(row).ID != 11 {
			want = append(want, pair{row, score})
		}
	}
	sort.Slice(want, func(i, j int) bool {
		if want[i].score == want[j].score {
			return want[i].row < want[j].row
		}
		return want[i].score > want[j].score
	})
	want = want[:2]

	got := idx.TopK(query, 2, map[int64]bool{11: true})
	if len(got) != len(want) {
		t.Fatalf("TopK len=%d, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i].Row != want[i].row || got[i].Score != want[i].score {
			t.Fatalf("TopK[%d]=%+v, want row=%d score=%f", i, got[i], want[i].row, want[i].score)
		}
	}
}

func TestTopKUsesStableRowTieBreak(t *testing.T) {
	idx := New(config.Config{})
	rows := []db.TrackRow{
		{ID: 1, Embedding: Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 2, Embedding: Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 3, Embedding: Float32Bytes([]float32{1, 0}), Dim: 2},
	}
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	got := idx.TopK([]float32{1, 0}, 2, nil)
	if len(got) != 2 || got[0].Row != 0 || got[1].Row != 1 {
		t.Fatalf("stable ties = %+v, want rows 0,1", got)
	}
}

func TestArtistAndAlbumIndexes(t *testing.T) {
	idx := testIndex(t)
	if got := idx.RowsForArtist(" artist a "); len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Fatalf("artist rows=%v, want [0 1]", got)
	}
	if got := idx.RowsForAlbum("", "second"); len(got) != 2 || got[0] != 2 || got[1] != 3 {
		t.Fatalf("album rows=%v, want [2 3]", got)
	}
	if got := idx.RowsForAlbum("artist b", "second"); len(got) != 1 || got[0] != 2 {
		t.Fatalf("artist album rows=%v, want [2]", got)
	}
	artists := idx.ArtistCentroids()
	if len(artists) != 3 {
		t.Fatalf("artist centroids=%d, want 3", len(artists))
	}
	for _, group := range artists {
		if len(group.Vector) != 2 {
			t.Fatalf("bad centroid for %q: %v", group.Artist, group.Vector)
		}
	}
	albums := idx.AlbumCentroids()
	if len(albums) != 3 {
		t.Fatalf("album centroids=%d, want 3", len(albums))
	}
}

func TestCloneIDsIncludesMD5AndSongKeyDuplicates(t *testing.T) {
	idx := New(config.Config{})
	rows := []db.TrackRow{
		{ID: 1, Artist: "Same", Title: "Song", FileMD5: "abc", Embedding: Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 2, Artist: "Same", Title: "Song", FileMD5: "other", Embedding: Float32Bytes([]float32{0.9, 0.1}), Dim: 2},
		{ID: 3, Artist: "Other", Title: "Track", FileMD5: "abc", Embedding: Float32Bytes([]float32{0, 1}), Dim: 2},
		{ID: 4, Artist: "Solo", Title: "Alone", FileMD5: "zzz", Embedding: Float32Bytes([]float32{-1, 0}), Dim: 2},
	}
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	got := idx.CloneIDs(1)
	seen := map[int64]bool{}
	for _, id := range got {
		seen[id] = true
	}
	for _, want := range []int64{1, 2, 3} {
		if !seen[want] {
			t.Fatalf("CloneIDs(1)=%v, missing %d", got, want)
		}
	}
	if seen[4] {
		t.Fatalf("CloneIDs(1)=%v unexpectedly includes unrelated id 4", got)
	}
	if got := idx.CloneIDs(99); len(got) != 1 || got[0] != 99 {
		t.Fatalf("missing track CloneIDs=%v, want [99]", got)
	}
}
