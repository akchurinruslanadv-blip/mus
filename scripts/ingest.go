package main

import (
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type TrackMeta struct {
	Path     string
	MD5      string
	Size     int64
	Title    string
	Artist   string
	Album    string
	Duration float64
}

func computeMD5(filePath string) (string, int64, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return "", 0, err
	}

	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), stat.Size(), nil
}

// parseFilename parses "Artist - Title [id].ext" or basic name
func parseFilename(filename string) (artist, title, album string) {
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	// Remove YouTube ID like [CCHdMIEGaaM]
	reID := regexp.MustCompile(`\s*\[[a-zA-Z0-9_-]{11}\]$`)
	base = reID.ReplaceAllString(base, "")

	if strings.Contains(base, " - ") {
		parts := strings.SplitN(base, " - ", 2)
		artist = strings.TrimSpace(parts[0])
		title = strings.TrimSpace(parts[1])
		// Remove leading prefix like "convar HUN" or repeated artist if present
		if strings.Contains(title, " - ") {
			sub := strings.SplitN(title, " - ", 2)
			artist = strings.TrimSpace(sub[0])
			title = strings.TrimSpace(sub[1])
		}
	} else {
		artist = "Unknown Artist"
		title = base
	}

	// Clean title from (Official Video), (Remastered 2009), etc.
	reExtra := regexp.MustCompile(`\s*\((Official Video|Official Music Video|Remastered[^)]*)\)`)
	title = reExtra.ReplaceAllString(title, "")
	album = "Dynamic Single"
	return artist, title, album
}

func main() {
	dbPath := "C:\\Users\\Admin\\Desktop\\musik-project\\data\\db\\musik.db"
	dynamicDir := "C:\\Users\\Admin\\Desktop\\musik-project\\dynamic"

	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", dbPath))
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	entries, err := os.ReadDir(dynamicDir)
	if err != nil {
		log.Fatalf("failed to read dynamic dir: %v", err)
	}

	knownDurations := map[string]float64{
		"queen.m4a": 355.0,
		"Get Lucky": 248.0,
		"Smells Like Teen Spirit": 301.0,
		"Yesterday": 125.0,
	}

	now := time.Now().UTC().Format(time.RFC3339)
	insertedCount := 0

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".m4a" && ext != ".webm" && ext != ".mp3" && ext != ".opus" && ext != ".flac" {
			continue
		}

		fullPath := filepath.Join(dynamicDir, entry.Name())
		hash, size, err := computeMD5(fullPath)
		if err != nil {
			log.Printf("error hashing %s: %v", entry.Name(), err)
			continue
		}

		artist, title, album := parseFilename(entry.Name())
		if entry.Name() == "queen.m4a" {
			artist = "Queen"
			title = "Bohemian Rhapsody"
			album = "A Night at the Opera"
		}

		dur := 180.0
		for k, d := range knownDurations {
			if strings.Contains(title, k) || strings.Contains(entry.Name(), k) {
				dur = d
				break
			}
		}

		res, err := db.Exec(`
INSERT INTO tracks (path, file_md5, file_size, title, artist, album, duration, is_active, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  file_md5=excluded.file_md5,
  file_size=excluded.file_size,
  title=excluded.title,
  artist=excluded.artist,
  album=excluded.album,
  duration=excluded.duration,
  updated_at=excluded.updated_at`,
			fullPath, hash, size, title, artist, album, dur, now, now)

		if err != nil {
			log.Printf("failed to insert track %s: %v", title, err)
			continue
		}

		// Get track id
		var trackID int64
		err = db.QueryRow(`SELECT id FROM tracks WHERE path = ?`, fullPath).Scan(&trackID)
		if err == nil && trackID > 0 {
			_, _ = db.Exec(`INSERT INTO features (track_id, status, computed_at) VALUES (?, 'pending', ?) ON CONFLICT(track_id) DO NOTHING`, trackID, now)
		}

		rowsAff, _ := res.RowsAffected()
		log.Printf("Registered track [%d]: %s — %s (%.0fs, %d KB, rows=%d)", trackID, artist, title, dur, size/1024, rowsAff)
		insertedCount++
	}

	log.Printf("Done! Registered %d tracks.", insertedCount)

	// Trigger player reload
	resp, err := http.Post("http://127.0.0.1:8787/api/reload", "application/json", nil)
	if err != nil {
		log.Printf("Note: could not call /api/reload: %v", err)
	} else {
		defer resp.Body.Close()
		log.Printf("Player reload response status: %s", resp.Status)
	}
}
