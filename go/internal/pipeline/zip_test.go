package pipeline

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func makeTestZip(t *testing.T, files map[string][]byte) string {
	t.Helper()
	buf := new(bytes.Buffer)
	w := zip.NewWriter(buf)

	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if content == nil {
			content = []byte("fake image data")
		}
		_, err = f.Write(content)
		if err != nil {
			t.Fatal(err)
		}
	}

	err := w.Close()
	if err != nil {
		t.Fatal(err)
	}

	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "test.zip")
	err = os.WriteFile(zipPath, buf.Bytes(), 0o644)
	if err != nil {
		t.Fatal(err)
	}

	return zipPath
}

func TestExtractAndValidateZip(t *testing.T) {
	t.Run("accepts 1.png", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
		})
		destDir := t.TempDir()
		files, err := ExtractAndValidateZip(zipPath, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(files) != 1 {
			t.Fatalf("expected 1 file, got %d", len(files))
		}
		if filepath.Base(files[0]) != "1.png" {
			t.Errorf("expected 1.png, got %s", filepath.Base(files[0]))
		}
	})

	t.Run("accepts sorted consecutive files", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"3.jpg": nil,
			"1.jpg": nil,
			"2.jpg": nil,
		})
		destDir := t.TempDir()
		files, err := ExtractAndValidateZip(zipPath, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(files) != 3 {
			t.Fatalf("expected 3 files, got %d", len(files))
		}
		expected := []string{"1.jpg", "2.jpg", "3.jpg"}
		for i, name := range expected {
			if filepath.Base(files[i]) != name {
				t.Errorf("expected %s at index %d, got %s", name, i, filepath.Base(files[i]))
			}
		}
	})

	t.Run("accepts zero padded names", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"01.jpeg": nil,
			"02.jpeg": nil,
		})
		destDir := t.TempDir()
		files, err := ExtractAndValidateZip(zipPath, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(files) != 2 {
			t.Fatalf("expected 2 files, got %d", len(files))
		}
	})

	t.Run("accepts new style parenthesized naming", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"dives (1).png": nil,
			"dives (2).png": nil,
		})
		destDir := t.TempDir()
		files, err := ExtractAndValidateZip(zipPath, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(files) != 2 {
			t.Fatalf("expected 2 files, got %d", len(files))
		}
		if filepath.Base(files[0]) != "dives (1).png" {
			t.Errorf("expected dives (1).png, got %s", filepath.Base(files[0]))
		}
	})

	t.Run("rejects empty zip", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{})
		destDir := t.TempDir()
		_, err := ExtractAndValidateZip(zipPath, destDir)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var zipErr *ZipError
		if !errors.As(err, &zipErr) || zipErr.Kind != "empty" {
			t.Errorf("expected empty ZipError, got %v", err)
		}
	})

	t.Run("rejects too many images", func(t *testing.T) {
		filesMap := map[string][]byte{
			"1.png": nil, "2.png": nil, "3.png": nil, "4.png": nil, "5.png": nil,
			"6.png": nil, "7.png": nil, "8.png": nil, "9.png": nil, "10.png": nil,
			"11.png": nil,
		}
		zipPath := makeTestZip(t, filesMap)
		destDir := t.TempDir()
		_, err := ExtractAndValidateZip(zipPath, destDir)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var zipErr *ZipError
		if !errors.As(err, &zipErr) || zipErr.Kind != "too_many" {
			t.Errorf("expected too_many ZipError, got %v", err)
		}
	})

	t.Run("rejects missing numbers in sequence", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
			"3.png": nil,
		})
		destDir := t.TempDir()
		_, err := ExtractAndValidateZip(zipPath, destDir)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var zipErr *ZipError
		if !errors.As(err, &zipErr) || zipErr.Kind != "missing_numbers" {
			t.Errorf("expected missing_numbers ZipError, got %v", err)
		}
	})

	t.Run("rejects wrong naming pattern", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"hello.png": nil,
		})
		destDir := t.TempDir()
		_, err := ExtractAndValidateZip(zipPath, destDir)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var zipErr *ZipError
		if !errors.As(err, &zipErr) || zipErr.Kind != "wrong_naming" {
			t.Errorf("expected wrong_naming ZipError, got %v", err)
		}
	})

	t.Run("ignores macos metadata and directories", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png":               nil,
			"__MACOSX/._1.png":    nil,
			".DS_Store":           nil,
			"sub/2.png":           nil,
			"ignored_non_img.txt": []byte("text"),
		})
		destDir := t.TempDir()
		files, err := ExtractAndValidateZip(zipPath, destDir)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(files) != 1 {
			t.Errorf("expected only 1 valid file, got %d", len(files))
		}
	})
}
