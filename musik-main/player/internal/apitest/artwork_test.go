package apitest

import (
	"image"
	"image/color"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/torwin-job/musik/player/internal/db"
	"github.com/torwin-job/musik/player/internal/index"
)

func TestHandleArtworkServesOriginalAndThumb(t *testing.T) {
	server := openTestServer(t)
	artPath := filepath.Join(t.TempDir(), "cover.png")
	img := image.NewRGBA(image.Rect(0, 0, 120, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 120; x++ {
			img.Set(x, y, color.RGBA{B: 200, A: 255})
		}
	}
	f, err := os.Create(artPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	loadIndex(t, server, []db.TrackRow{
		{ID: 11, Title: "Track", Artist: "Artist", Album: "Album", Duration: 180,
			ArtworkPath: artPath, Embedding: index.Float32Bytes([]float32{1, 0}), Dim: 2},
		{ID: 22, Title: "Track", Artist: "Artist", Album: "Album", Duration: 180,
			Embedding: index.Float32Bytes([]float32{0, 1}), Dim: 2},
	})

	rec := serve(server, httptest.NewRequest("GET", "/api/artwork/11", nil))
	if rec.Code != 200 {
		t.Fatalf("original status=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type=%q, want image/png", ct)
	}
	if len(rec.Body.Bytes()) < 50 {
		t.Fatal("expected image bytes")
	}

	rec = serve(server, httptest.NewRequest("GET", "/api/artwork/11?w=64", nil))
	if rec.Code != 200 {
		t.Fatalf("thumb status=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("thumb content-type=%q, want image/jpeg", ct)
	}
	thumb := filepath.Join(filepath.Dir(filepath.Dir(server.Cfg.DBPath)), "cache", "art", "11_w64.jpg")
	if _, err := os.Stat(thumb); err != nil {
		t.Fatalf("thumb file missing: %v", err)
	}

	rec = serve(server, httptest.NewRequest("GET", "/api/artwork/11?w=64", nil))
	if rec.Code != 200 {
		t.Fatalf("cached thumb status=%d", rec.Code)
	}

	rec = serve(server, httptest.NewRequest("GET", "/api/artwork/22", nil))
	if rec.Code != 404 {
		t.Fatalf("missing artwork status=%d, want 404", rec.Code)
	}
}

func TestHandleArtworkBadID(t *testing.T) {
	server := openTestServer(t)
	rec := serve(server, httptest.NewRequest("GET", "/api/artwork/x", nil))
	if rec.Code != 400 {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
}
