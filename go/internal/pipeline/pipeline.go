package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"squish-to-approve/internal/config"
	"squish-to-approve/internal/google"
)

// Input is the per-request payload passed in from the WhatsApp client.
type Input struct {
	MsgID          string
	ZipData        []byte
	CaptionText    string
	OutputFolderID string
}

// Result is returned on success.
type Result struct {
	URL       string
	FolderURL string
	DocName   string
}

// Run executes the full pipeline for one request:
//
//	parseCaption → extractZip → createFolder → uploadImages (parallel)
//	→ copyTemplate → fillDoc → renameFile → shareDoc → return Result
//
// Returns an error whose message is safe to send to the user.
func Run(ctx context.Context, cfg *config.Config, httpClient *http.Client, in Input) (Result, error) {
	tempDir := filepath.Join(os.TempDir(), fmt.Sprintf("carousel-%s", in.MsgID))
	defer CleanupLocalDir(tempDir)

	// ── Parse text ──────────────────────────────────────────────────────────
	parsed := ParseCaption(in.CaptionText)
	if parsed.Title == "" {
		return Result{}, fmt.Errorf("⚠️ The caption needs a title on the first line.")
	}

	// ── Write & extract zip ─────────────────────────────────────────────────
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return Result{}, fmt.Errorf("⚠️ Internal error setting up temp dir.")
	}
	zipPath := filepath.Join(tempDir, "upload.zip")
	if err := os.WriteFile(zipPath, in.ZipData, 0o644); err != nil {
		return Result{}, fmt.Errorf("⚠️ Internal error writing zip.")
	}

	extractDir := filepath.Join(tempDir, "images")
	imageFiles, err := ExtractAndValidateZip(zipPath, extractDir)
	if err != nil {
		var zipErr *ZipError
		if errors.As(err, &zipErr) {
			switch zipErr.Kind {
			case "empty":
				return Result{}, fmt.Errorf("⚠️ The zip is empty.")
			case "too_many":
				return Result{}, fmt.Errorf("⚠️ Max 10 images per carousel.")
			case "wrong_naming", "missing_numbers":
				return Result{}, fmt.Errorf("⚠️ Images should contain distinct numbers (e.g. 1.jpg, 2.jpg, frame_028.jpg).")
			}
		}
		return Result{}, fmt.Errorf("⚠️ Could not read the zip: %v", err)
	}

	// ── Create campaign folder ──────────────────────────────────────────────
	targetFolderID := in.OutputFolderID
	if targetFolderID == "" {
		targetFolderID = cfg.OutputFolderID
	}
	campaignFolderID, err := google.CreateFolder(ctx, httpClient, targetFolderID, parsed.Title)
	if err != nil {
		slog.Error("createFolder failed", "err", err)
		return Result{}, fmt.Errorf("❌ Couldn't create the campaign folder. Check the logs.")
	}

	// ── Upload images in parallel ───────────────────────────────────────────
	imageSlots := make([]google.ImageSlot, len(imageFiles))
	var wg sync.WaitGroup
	errs := make([]error, len(imageFiles))
	for i, f := range imageFiles {
		wg.Add(1)
		go func(i int, f string) {
			defer wg.Done()
			slot, err := google.UploadImage(ctx, httpClient, f, campaignFolderID)
			if err != nil {
				errs[i] = err
				return
			}
			imageSlots[i] = slot
		}(i, f)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			slog.Error("uploadImage failed", "err", e)
			return Result{}, fmt.Errorf("❌ Failed to upload one or more images. Check the logs.")
		}
	}

	// ── Select template and copy ────────────────────────────────────────────
	igOnly := strings.Contains(parsed.CaptionBody, cfg.TriggerURL)
	templateID := cfg.TemplateIDIGFB
	if igOnly {
		templateID = cfg.TemplateIDIG
	}

	docID, err := google.CopyTemplate(ctx, httpClient, templateID, parsed.Title, campaignFolderID)
	if err != nil {
		slog.Error("copyTemplate failed", "err", err)
		return Result{}, fmt.Errorf("❌ Couldn't copy the template. Check the logs.")
	}

	// ── Fill document ───────────────────────────────────────────────────────
	if err := google.FillDoc(ctx, httpClient, docID, parsed.Title, parsed.CaptionBody, parsed.Hashtags, imageSlots); err != nil {
		slog.Error("fillDoc failed", "err", err)
		return Result{}, fmt.Errorf("❌ Couldn't build the doc. Check the logs.")
	}

	// ── Rename ──────────────────────────────────────────────────────────────
	docName := fmt.Sprintf("[APPROVAL | GRAPHICS] %s", parsed.Title)
	if err := google.RenameFile(ctx, httpClient, docID, docName); err != nil {
		slog.Error("renameFile failed", "err", err)
		// Non-fatal — doc still usable
	}

	// ── Share ────────────────────────────────────────────────────────────────
	if err := google.ShareDoc(ctx, httpClient, docID, cfg.OutputDocPermission); err != nil {
		slog.Error("shareDoc failed", "err", err)
	}

	return Result{
		URL:       fmt.Sprintf("https://docs.google.com/document/d/%s/edit", docID),
		FolderURL: fmt.Sprintf("https://drive.google.com/drive/folders/%s", campaignFolderID),
		DocName:   docName,
	}, nil
}
