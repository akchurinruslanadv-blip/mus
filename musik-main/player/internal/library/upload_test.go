package library

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeRelPath(t *testing.T) {
	ok, err := SanitizeRelPath(`Band\LP\song.mp3`)
	if err != nil {
		t.Fatal(err)
	}
	if ok != filepath.Join("Band", "LP", "song.mp3") {
		t.Fatalf("got %q", ok)
	}
	if _, err := SanitizeRelPath("../../x.mp3"); err == nil {
		t.Fatal("expected traversal error")
	}
	if _, err := SanitizeRelPath("cover.jpg"); err == nil {
		t.Fatal("expected extension error")
	}
	if _, err := SanitizeRelPath(".secret/hidden.mp3"); err == nil {
		t.Fatal("expected hidden path error")
	}
}

func TestSaveFileWritesUnderRoot(t *testing.T) {
	root := t.TempDir()
	rel := filepath.Join("Artist", "Album", "track.flac")
	n, err := SaveFile(root, rel, strings.NewReader("fLaCfake"))
	if err != nil {
		t.Fatal(err)
	}
	if n != 8 {
		t.Fatalf("bytes=%d", n)
	}
	got, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "fLaCfake" {
		t.Fatalf("contents=%q", got)
	}
}

func TestResolveDestRejectsEscape(t *testing.T) {
	root := t.TempDir()
	if _, err := ResolveDest(root, filepath.Join("..", "escape.mp3")); err == nil {
		t.Fatal("expected escape error")
	}
}
