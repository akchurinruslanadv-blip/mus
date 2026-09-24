package library

import (
	"testing"

	"github.com/torwin-job/musik/player/internal/config"
	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
)

func testIndex(t *testing.T, rows []db.TrackRow) *index.Index {
	t.Helper()
	idx := index.New(config.Config{})
	if err := idx.Load(rows); err != nil {
		t.Fatal(err)
	}
	return idx
}

func vec(id int64) []byte {
	return index.Float32Bytes([]float32{1, float32(id)})
}

func TestMatchArtistAlbum(t *testing.T) {
	if !MatchArtistAlbum("Massive Attack", "Mezzanine", " massive attack ", "") {
		t.Fatal("artist match should be case-insensitive")
	}
	if MatchArtistAlbum("Massive Attack", "Protection", "Massive Attack", "mezzanine") {
		t.Fatal("album mismatch should fail")
	}
	if !MatchArtistAlbum("Portishead", "Dummy", "", "") {
		t.Fatal("empty filters should match")
	}
}

func TestGroupArtistsAndAlbums(t *testing.T) {
	idx := testIndex(t, []db.TrackRow{
		{ID: 1, Title: "One", Artist: "Massive Attack", Album: "Mezzanine", Embedding: vec(1), Dim: 2, ArtworkPath: "/a.png"},
		{ID: 2, Title: "Two", Artist: "Massive Attack", Album: "Protection", Embedding: vec(2), Dim: 2},
		{ID: 3, Title: "Three", Artist: "Portishead", Album: "Dummy", Embedding: vec(3), Dim: 2},
		{ID: 4, Title: "Four", Artist: "", Album: "", Embedding: vec(4), Dim: 2},
	})

	artists := GroupArtists(idx)
	if len(artists) != 3 {
		t.Fatalf("artists=%d, want 3: %+v", len(artists), artists)
	}
	if artists[0].Artist != "Massive Attack" || artists[0].Tracks != 2 || !artists[0].HasArtwork {
		t.Fatalf("top artist=%+v", artists[0])
	}

	albums := GroupAlbums(idx)
	if len(albums) != 3 {
		t.Fatalf("albums=%d, want 3 (empty album skipped): %+v", len(albums), albums)
	}
}
