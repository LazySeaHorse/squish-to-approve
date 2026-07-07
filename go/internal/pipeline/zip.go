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

// Naming accepts either "name (N).ext" or "0*N.ext" — same as TS zip.ts.
var nameRe = regexp.MustCompile(`(?i)^(?:.*\((\d+)\)|0*(\d+))\.(jpg|jpeg|png)$`)

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

		m := nameRe.FindStringSubmatch(name)
		if m == nil {
			return nil, &ZipError{
				Kind:    "wrong_naming",
				Message: fmt.Sprintf("%q doesn't match expected naming (e.g. 1.jpg, \"dives (1).png\").", name),
			}
		}
		numStr := m[1]
		if numStr == "" {
			numStr = m[2]
		}
		n, _ := strconv.Atoi(numStr)
		entries = append(entries, numbered{n: n, name: name, file: f})
	}

	if len(entries) == 0 {
		return nil, &ZipError{Kind: "empty", Message: "The zip is empty."}
	}
	if len(entries) > maxImages {
		return nil, &ZipError{Kind: "too_many", Message: fmt.Sprintf("%d images found; max is %d.", len(entries), maxImages)}
	}

	// Sort and validate consecutive 1..N
	sort.Slice(entries, func(i, j int) bool { return entries[i].n < entries[j].n })
	for i, e := range entries {
		if e.n != i+1 {
			return nil, &ZipError{
				Kind:    "missing_numbers",
				Message: fmt.Sprintf("Expected slide %d but found slide %d.", i+1, e.n),
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
		paths[i] = dest
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
