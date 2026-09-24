// Package recommend scores similar tracks, artists, and albums from the
// in-memory index. HTTP mapping lives in internal/api.
package recommend

import (
	"math/rand"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
)

type TrackHit struct {
	ID         int64
	Artist     string
	Title      string
	Album      string
	Duration   float64
	Cosine     float64
	HasArtwork bool
}

type ArtistHit struct {
	Artist       string
	Tracks       int
	Cosine       float64
	CoverTrackID int64
	HasArtwork   bool
	Explanation  string
}

type AlbumHit struct {
	Artist       string
	Album        string
	Tracks       int
	Cosine       float64
	CoverTrackID int64
	HasArtwork   bool
	Explanation  string
}

func TopTracks(idx *index.Index, vec []float32, exclude map[int64]bool, limit int) []TrackHit {
	if idx == nil || len(vec) == 0 || limit <= 0 {
		return nil
	}
	pairs := idx.TopK(vec, limit, exclude)
	out := make([]TrackHit, 0, len(pairs))
	for _, p := range pairs {
		m := idx.MetaAt(p.Row)
		out = append(out, TrackHit{
			ID: m.ID, Artist: m.Artist, Title: m.Title, Album: m.Album,
			Duration: m.Duration, Cosine: float64(p.Score),
			HasArtwork: m.ArtworkPath != "",
		})
	}
	return out
}

func SimilarTracks(idx *index.Index, trackID int64, limit int) []TrackHit {
	row, ok := idx.RowOf(trackID)
	if !ok {
		return nil
	}
	exclude := map[int64]bool{}
	for _, cloneID := range idx.CloneIDs(trackID) {
		exclude[cloneID] = true
	}
	return TopTracks(idx, idx.Vector(row), exclude, limit)
}

func FromTrack(idx *index.Index, trackID int64, limit int) []TrackHit {
	row, ok := idx.RowOf(trackID)
	if !ok {
		return nil
	}
	return TopTracks(idx, idx.Vector(row), map[int64]bool{trackID: true}, limit)
}

func FromArtist(idx *index.Index, artist string, limit int) []TrackHit {
	rows := idx.RowsForArtist(artist)
	exclude := map[int64]bool{}
	for _, ri := range rows {
		exclude[idx.MetaAt(ri).ID] = true
	}
	return TopTracks(idx, idx.CentroidOf(rows), exclude, limit)
}

func FromAlbum(idx *index.Index, artist, album string, limit int) []TrackHit {
	rows := idx.RowsForAlbum(artist, album)
	exclude := map[int64]bool{}
	for _, ri := range rows {
		exclude[idx.MetaAt(ri).ID] = true
	}
	return TopTracks(idx, idx.CentroidOf(rows), exclude, limit)
}

func SimilarArtists(idx *index.Index, seedArtist string, limit int) []ArtistHit {
	if idx == nil {
		return nil
	}
	seedRows := idx.RowsForArtist(seedArtist)
	seedVec := idx.CentroidOf(seedRows)
	if seedVec == nil {
		return nil
	}
	seedKey := strings.ToLower(strings.TrimSpace(seedArtist))
	type scored struct {
		artist string
		rows   []int
		sim    float32
	}
	var all []scored
	for _, group := range idx.ArtistCentroids() {
		if strings.ToLower(strings.TrimSpace(group.Artist)) == seedKey {
			continue
		}
		var sim float32
		for d := range group.Vector {
			sim += group.Vector[d] * seedVec[d]
		}
		all = append(all, scored{group.Artist, group.Rows, sim})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].sim > all[j].sim })
	if len(all) > limit {
		all = all[:limit]
	}
	out := make([]ArtistHit, 0, len(all))
	for _, a := range all {
		m := idx.MetaAt(a.rows[0])
		out = append(out, ArtistHit{
			Artist: a.artist, Tracks: len(a.rows), Cosine: float64(a.sim),
			CoverTrackID: m.ID, HasArtwork: m.ArtworkPath != "",
			Explanation: "похоже на «" + seedArtist + "»",
		})
	}
	return out
}

func SimilarAlbums(idx *index.Index, seedArtist, seedAlbum string, limit int) []AlbumHit {
	if idx == nil {
		return nil
	}
	seedRows := idx.RowsForAlbum(seedArtist, seedAlbum)
	seedVec := idx.CentroidOf(seedRows)
	if seedVec == nil {
		return nil
	}
	seedAl := strings.ToLower(strings.TrimSpace(seedAlbum))
	seedAr := strings.ToLower(strings.TrimSpace(seedArtist))
	type scored struct {
		artist, album string
		rows          []int
		sim           float32
	}
	var all []scored
	for _, group := range idx.AlbumCentroids() {
		artistKey := strings.ToLower(strings.TrimSpace(group.Artist))
		albumKey := strings.ToLower(strings.TrimSpace(group.Album))
		if albumKey == seedAl && (seedAr == "" || artistKey == seedAr) {
			continue
		}
		var sim float32
		for d := range group.Vector {
			sim += group.Vector[d] * seedVec[d]
		}
		all = append(all, scored{group.Artist, group.Album, group.Rows, sim})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].sim > all[j].sim })
	if len(all) > limit {
		all = all[:limit]
	}
	out := make([]AlbumHit, 0, len(all))
	for _, a := range all {
		m := idx.MetaAt(a.rows[0])
		out = append(out, AlbumHit{
			Artist: a.artist, Album: a.album, Tracks: len(a.rows),
			Cosine: float64(a.sim), CoverTrackID: m.ID, HasArtwork: m.ArtworkPath != "",
			Explanation: "похоже на «" + seedAlbum + "»",
		})
	}
	return out
}

type FavoritesMix struct {
	Empty   bool
	BasedOn map[string]any
	Tracks  []TrackHit
	Artists []ArtistHit
	Albums  []AlbumHit
}

func FromFavorites(store *db.Store, idx *index.Index) FavoritesMix {
	exclude := map[int64]bool{}
	if recent, err := store.RecentTrackIDs(24*7, 500); err == nil {
		for _, id := range recent {
			exclude[id] = true
		}
	}
	var vecs [][]float32
	basedOn := map[string]any{}

	favTracks, _ := store.FavoritesList()
	trackTitles := make([]string, 0, len(favTracks))
	for _, t := range favTracks {
		exclude[t.TrackID] = true
		if row, ok := idx.RowOf(t.TrackID); ok {
			vecs = append(vecs, idx.Vector(row))
			trackTitles = append(trackTitles, t.Title)
		}
	}
	basedOn["tracks"] = trackTitles

	favArtists, _ := store.FavArtistsList()
	artistNames := make([]string, 0, len(favArtists))
	for _, a := range favArtists {
		artistNames = append(artistNames, a.Artist)
		rows := idx.RowsForArtist(a.Artist)
		for _, r := range rows {
			exclude[idx.MetaAt(r).ID] = true
		}
		if v := idx.CentroidOf(rows); v != nil {
			vecs = append(vecs, v)
		}
	}
	basedOn["artists"] = artistNames

	favAlbums, _ := store.FavAlbumsList()
	albumNames := make([]string, 0, len(favAlbums))
	for _, a := range favAlbums {
		albumNames = append(albumNames, a.Artist+" — "+a.Album)
		rows := idx.RowsForAlbum(a.Artist, a.Album)
		for _, r := range rows {
			exclude[idx.MetaAt(r).ID] = true
		}
		if v := idx.CentroidOf(rows); v != nil {
			vecs = append(vecs, v)
		}
	}
	basedOn["albums"] = albumNames

	if len(vecs) == 0 {
		return FavoritesMix{Empty: true, BasedOn: basedOn}
	}

	dim := len(vecs[0])
	sum := make([]float64, dim)
	used := 0
	for _, v := range vecs {
		if len(v) != dim {
			continue
		}
		for d := 0; d < dim; d++ {
			sum[d] += float64(v[d])
		}
		used++
	}
	q := make([]float32, dim)
	inv := 1.0 / float64(used)
	for d := 0; d < dim; d++ {
		q[d] = float32(sum[d] * inv)
	}
	index.Normalize(q)

	tracks := TopTracks(idx, q, exclude, 48)
	daySeed, _ := strconv.ParseInt(time.Now().Format("20060102"), 10, 64)
	rng := rand.New(rand.NewSource(daySeed))
	rng.Shuffle(len(tracks), func(i, j int) { tracks[i], tracks[j] = tracks[j], tracks[i] })
	if len(tracks) > 24 {
		tracks = tracks[:24]
	}

	var simArtists []ArtistHit
	var simAlbums []AlbumHit
	day := time.Now().YearDay()
	if len(favArtists) > 0 {
		seed := favArtists[day%len(favArtists)]
		simArtists = SimilarArtists(idx, seed.Artist, 10)
	} else if len(favTracks) > 0 {
		seed := favTracks[day%len(favTracks)]
		simArtists = SimilarArtists(idx, seed.Artist, 10)
	}
	if len(favAlbums) > 0 {
		seed := favAlbums[day%len(favAlbums)]
		simAlbums = SimilarAlbums(idx, seed.Artist, seed.Album, 10)
	} else if len(favTracks) > 0 {
		seed := favTracks[day%len(favTracks)]
		if row, ok := idx.RowOf(seed.TrackID); ok {
			m := idx.MetaAt(row)
			if m.Album != "" {
				simAlbums = SimilarAlbums(idx, m.Artist, m.Album, 10)
			}
		}
	}

	return FavoritesMix{
		BasedOn: basedOn, Tracks: tracks, Artists: simArtists, Albums: simAlbums,
	}
}
