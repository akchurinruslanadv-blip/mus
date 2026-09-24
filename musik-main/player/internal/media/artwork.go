package media

import (
	"bytes"
	"image"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "image/gif"
	_ "image/png"
)

// ServeArtwork serves an original artwork file or a cached, width-clamped thumbnail.
func (s *Service) ServeArtwork(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	row, ok := s.idx.RowOf(id)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	path := s.idx.MetaAt(row).ArtworkPath
	if path == "" {
		http.Error(w, "no artwork", http.StatusNotFound)
		return
	}

	maxWidth := 0
	if queryWidth := r.URL.Query().Get("w"); queryWidth != "" {
		if width, err := strconv.Atoi(queryWidth); err == nil {
			maxWidth = width
		}
	}
	if maxWidth > 0 {
		if maxWidth < 48 {
			maxWidth = 48
		}
		if maxWidth > 512 {
			maxWidth = 512
		}
	}

	w.Header().Set("Cache-Control", "private, max-age=86400")
	if maxWidth > 0 {
		if thumb, err := s.ensureArtworkThumbnail(id, path, maxWidth); err == nil && thumb != "" {
			file, err := os.Open(thumb)
			if err == nil {
				defer file.Close()
				stat, _ := file.Stat()
				w.Header().Set("Content-Type", "image/jpeg")
				http.ServeContent(w, r, filepath.Base(thumb), stat.ModTime(), file)
				return
			}
		}
	}

	file, err := os.Open(path)
	if err != nil {
		http.Error(w, "file missing", http.StatusNotFound)
		return
	}
	defer file.Close()
	stat, _ := file.Stat()
	if mediaType := imageContentType(path); mediaType != "" {
		w.Header().Set("Content-Type", mediaType)
	}
	http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), file)
}

func imageContentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return ""
	}
}

func (s *Service) ensureArtworkThumbnail(id int64, srcPath string, maxWidth int) (string, error) {
	dir := s.artworkCacheDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, strconv.FormatInt(id, 10)+"_w"+strconv.Itoa(maxWidth)+".jpg")
	srcInfo, err := os.Stat(srcPath)
	if err != nil {
		return "", err
	}
	if dstInfo, err := os.Stat(dst); err == nil && !dstInfo.ModTime().Before(srcInfo.ModTime()) {
		return dst, nil
	}

	raw, err := os.ReadFile(srcPath)
	if err != nil {
		return "", err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	out := resizeMax(img, maxWidth)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, out, &jpeg.Options{Quality: 78}); err != nil {
		return "", err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, encoded.Bytes(), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

func resizeMax(src image.Image, maxWidth int) image.Image {
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return src
	}
	if width <= maxWidth && height <= maxWidth {
		return src
	}
	newWidth, newHeight := maxWidth, maxWidth
	if width > height {
		newHeight = height * maxWidth / width
		if newHeight < 1 {
			newHeight = 1
		}
	} else {
		newWidth = width * maxWidth / height
		if newWidth < 1 {
			newWidth = 1
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	for y := 0; y < newHeight; y++ {
		sourceY := bounds.Min.Y + y*height/newHeight
		for x := 0; x < newWidth; x++ {
			sourceX := bounds.Min.X + x*width/newWidth
			dst.Set(x, y, src.At(sourceX, sourceY))
		}
	}
	return dst
}
