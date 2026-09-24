package apitest

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLibraryUploadSavesFolderAndRejectsUnsafe(t *testing.T) {
	server := openTestServer(t)
	lib := t.TempDir()
	server.Cfg.Library = lib

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	writePart := func(filename, path, content string) {
		t.Helper()
		fw, err := mw.CreateFormFile("file", filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		if err := mw.WriteField("path", path); err != nil {
			t.Fatal(err)
		}
	}
	writePart("track.flac", "Artist/Album/track.flac", "fLaCfake")
	writePart("escape.mp3", "../escape.mp3", "nope")
	writePart("notes.txt", "Artist/Album/notes.txt", "text")
	writePart("hidden.mp3", ".secret/hidden.mp3", "nope")
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("POST", "/api/library/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := serve(server, req)
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var out struct {
		OK    bool `json:"ok"`
		Count int  `json:"count"`
		Saved []struct {
			Path string `json:"path"`
		} `json:"saved"`
		Skipped []struct {
			Path   string `json:"path"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Count != 1 || len(out.Saved) != 1 {
		t.Fatalf("unexpected result: %+v", out)
	}
	if out.Saved[0].Path != filepath.Join("Artist", "Album", "track.flac") {
		t.Fatalf("saved path=%q", out.Saved[0].Path)
	}
	if len(out.Skipped) != 3 {
		t.Fatalf("skipped=%+v", out.Skipped)
	}

	got, err := os.ReadFile(filepath.Join(lib, "Artist", "Album", "track.flac"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "fLaCfake" {
		t.Fatalf("file contents=%q", got)
	}
	if _, err := os.Stat(filepath.Join(lib, "escape.mp3")); err == nil {
		t.Fatal("escaped file was written")
	}
}

func TestLibraryUploadRequiresFiles(t *testing.T) {
	server := openTestServer(t)
	server.Cfg.Library = t.TempDir()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/library/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := serve(server, req)
	if rec.Code != 400 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
