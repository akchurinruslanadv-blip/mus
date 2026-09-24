package library

import (
	"sort"
	"strings"

	"github.com/torwin-job/musik/player/internal/index"
)

type ArtistGroup struct {
	Artist       string
	Tracks       int
	CoverTrackID int64
	HasArtwork   bool
}

type AlbumGroup struct {
	Artist       string
	Album        string
	Tracks       int
	CoverTrackID int64
	HasArtwork   bool
}

func MatchArtistAlbum(gotArtist, gotAlbum, wantArtist, wantAlbum string) bool {
	if wantArtist != "" && !strings.EqualFold(strings.TrimSpace(gotArtist), strings.TrimSpace(wantArtist)) {
		return false
	}
	if wantAlbum != "" && !strings.EqualFold(strings.TrimSpace(gotAlbum), strings.TrimSpace(wantAlbum)) {
		return false
	}
	return true
}

func GroupArtists(idx *index.Index) []ArtistGroup {
	if idx == nil {
		return nil
	}
	by := map[string]*ArtistGroup{}
	n := idx.Size()
	for i := 0; i < n; i++ {
		m := idx.MetaAt(i)
		name := strings.TrimSpace(m.Artist)
		if name == "" {
			name = "Unknown"
		}
		key := strings.ToLower(name)
		g := by[key]
		if g == nil {
			g = &ArtistGroup{Artist: name, CoverTrackID: m.ID, HasArtwork: m.ArtworkPath != ""}
			by[key] = g
		}
		g.Tracks++
	}
	out := make([]ArtistGroup, 0, len(by))
	for _, g := range by {
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Tracks != out[j].Tracks {
			return out[i].Tracks > out[j].Tracks
		}
		return out[i].Artist < out[j].Artist
	})
	return out
}

func GroupAlbums(idx *index.Index) []AlbumGroup {
	if idx == nil {
		return nil
	}
	by := map[string]*AlbumGroup{}
	n := idx.Size()
	for i := 0; i < n; i++ {
		m := idx.MetaAt(i)
		album := strings.TrimSpace(m.Album)
		if album == "" {
			continue
		}
		artist := strings.TrimSpace(m.Artist)
		key := strings.ToLower(artist) + "\x00" + strings.ToLower(album)
		g := by[key]
		if g == nil {
			g = &AlbumGroup{
				Artist: artist, Album: album,
				CoverTrackID: m.ID, HasArtwork: m.ArtworkPath != "",
			}
			by[key] = g
		}
		g.Tracks++
	}
	out := make([]AlbumGroup, 0, len(by))
	for _, g := range by {
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Tracks != out[j].Tracks {
			return out[i].Tracks > out[j].Tracks
		}
		return out[i].Album < out[j].Album
	})
	return out
}
