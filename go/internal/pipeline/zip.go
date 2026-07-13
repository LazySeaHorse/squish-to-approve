package pipeline

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const maxImages = 10

// imageExts is the set of accepted image extensions (lowercase).
var imageExts = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
}

// nameRe extracts the last sequence of digits in the base filename (excluding extension).
var nameRe = regexp.MustCompile(`(\d+)\D*$`)

// ZipError is a typed validation error, matching the TS ZipValidationError.
type ZipError struct {
	Kind    string // "empty" | "too_many" | "wrong_naming" | "missing_numbers"
	Message string
}

func (e *ZipError) Error() string { return e.Message }

// ExtractAndValidateZip validates and extracts a zip file.
// Returns sorted absolute paths of image files, or a *ZipError on failure.
// Mirrors extractAndValidateZip in src/pipeline/zip.ts exactly.
func ExtractAndValidateZip(zipPath, destDir string) ([]string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}
	defer r.Close()

	type numbered struct {
		n    int
		name string
		file *zip.File
	}

	// Filter to root-level image files only (no path separator in name)
	var entries []numbered
	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.Base(f.Name)
		// Root-level only: reject entries with a directory component
		if strings.Contains(f.Name, "/") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !imageExts[ext] {
			continue
		}

		base := name[:len(name)-len(ext)]
		m := nameRe.FindStringSubmatch(base)
		if m == nil {
			return nil, &ZipError{
				Kind:    "wrong_naming",
				Message: fmt.Sprintf("%q doesn't contain a slide number (e.g. 1.jpg, \"dives (1).png\", \"frame_028.png\").", name),
			}
		}
		numStr := m[1]
		n, err := strconv.Atoi(numStr)
		if err != nil {
			return nil, &ZipError{
				Kind:    "wrong_naming",
				Message: fmt.Sprintf("Slide number %q in %q is too large.", numStr, name),
			}
		}
		entries = append(entries, numbered{n: n, name: name, file: f})
	}

	if len(entries) == 0 {
		return nil, &ZipError{Kind: "empty", Message: "The zip is empty."}
	}
	if len(entries) > maxImages {
		return nil, &ZipError{Kind: "too_many", Message: fmt.Sprintf("%d images found; max is %d.", len(entries), maxImages)}
	}

	// Sort and validate unique numbers
	sort.Slice(entries, func(i, j int) bool { return entries[i].n < entries[j].n })
	for i := 0; i < len(entries)-1; i++ {
		if entries[i].n == entries[i+1].n {
			return nil, &ZipError{
				Kind:    "wrong_naming",
				Message: fmt.Sprintf("Duplicate slide number %d found in files %q and %q.", entries[i].n, entries[i].name, entries[i+1].name),
			}
		}
	}

	// Extract
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir destDir: %w", err)
	}

	paths := make([]string, len(entries))
	for i, e := range entries {
		dest := filepath.Join(destDir, e.name)
		if err := extractFile(e.file, dest); err != nil {
			return nil, fmt.Errorf("extract %s: %w", e.name, err)
		}

		// Convert to JPEG (80% quality) and delete original to save Drive space (since Docs API doesn't support WebP)
		jpgName := strings.TrimSuffix(e.name, filepath.Ext(e.name)) + ".jpg"
		jpgDest := filepath.Join(destDir, jpgName)

		if err := ConvertToJPEG(dest, jpgDest, 80); err != nil {
			return nil, fmt.Errorf("convert %s to jpeg: %w", e.name, err)
		}
		_ = os.Remove(dest)

		paths[i] = jpgDest
	}

	return paths, nil
}

// CountImagesInZip counts root-level image files without extracting.
// Used for the batch-mode preview. Returns 0 on any read error.
func CountImagesInZip(zipPath string) int {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0
	}
	defer r.Close()
	count := 0
	for _, f := range r.File {
		if f.FileInfo().IsDir() || strings.Contains(f.Name, "/") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(f.Name))
		if imageExts[ext] {
			count++
		}
	}
	return count
}

func extractFile(f *zip.File, dest string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, rc)
	return err
}
