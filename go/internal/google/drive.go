package google

import (
	"context"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

// ImageSlot is returned by UploadImage and consumed by FillDoc.
type ImageSlot struct {
	DriveFileID string
	PublicURL   string
}

func newDriveService(ctx context.Context, client *http.Client) (*drive.Service, error) {
	return drive.NewService(ctx, option.WithHTTPClient(client))
}

// CreateFolder creates a subfolder inside parentFolderID and returns its ID.
func CreateFolder(ctx context.Context, client *http.Client, parentFolderID, folderName string) (string, error) {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return "", fmt.Errorf("drive service: %w", err)
	}
	f, err := svc.Files.Create(&drive.File{
		Name:     folderName,
		MimeType: "application/vnd.google-apps.folder",
		Parents:  []string{parentFolderID},
	}).Fields("id").Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("createFolder: %w", err)
	}
	return f.Id, nil
}

// CopyTemplate copies a template doc into campaignFolderID with a timestamped name.
func CopyTemplate(ctx context.Context, client *http.Client, templateID, title, campaignFolderID string) (string, error) {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return "", fmt.Errorf("drive service: %w", err)
	}
	truncated := title
	if len(truncated) > 80 {
		truncated = truncated[:80]
	}
	now := time.Now().UTC().Format("2006-01-02 15:04")
	name := fmt.Sprintf("Approval - %s - %s", truncated, now)

	f, err := svc.Files.Copy(templateID, &drive.File{
		Name:    name,
		Parents: []string{campaignFolderID},
	}).Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("copyTemplate: %w", err)
	}
	return f.Id, nil
}

// UploadImage uploads a local image file to campaignFolderID, sets it readable
// by anyone, and returns its Drive ID and the public URL used by the Docs API.
//
// URL format: https://drive.google.com/uc?id=<fileId>
// This is the same format as the TS implementation. If the Docs API ever rejects
// it, switch to the webContentLink returned by the files.create response.
func UploadImage(ctx context.Context, client *http.Client, filePath, campaignFolderID string) (ImageSlot, error) {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return ImageSlot{}, fmt.Errorf("drive service: %w", err)
	}

	name := filepath.Base(filePath)
	mimeType := mimeForImage(name)

	f, err := os.Open(filePath)
	if err != nil {
		return ImageSlot{}, fmt.Errorf("open image: %w", err)
	}
	defer f.Close()

	created, err := svc.Files.Create(&drive.File{
		Name:    name,
		Parents: []string{campaignFolderID},
	}).Media(f, googleapi.ContentType(mimeType)).Fields("id").Context(ctx).Do()
	if err != nil {
		return ImageSlot{}, fmt.Errorf("uploadImage create: %w", err)
	}

	_, err = svc.Permissions.Create(created.Id, &drive.Permission{
		Role: "reader",
		Type: "anyone",
	}).Context(ctx).Do()
	if err != nil {
		return ImageSlot{}, fmt.Errorf("uploadImage permission: %w", err)
	}

	return ImageSlot{
		DriveFileID: created.Id,
		PublicURL:   fmt.Sprintf("https://drive.google.com/uc?id=%s", created.Id),
	}, nil
}

// RenameFile updates the name of a Drive file.
func RenameFile(ctx context.Context, client *http.Client, fileID, newName string) error {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return fmt.Errorf("drive service: %w", err)
	}
	_, err = svc.Files.Update(fileID, &drive.File{Name: newName}).Context(ctx).Do()
	if err != nil {
		return fmt.Errorf("renameFile: %w", err)
	}
	return nil
}

// DeleteFile deletes a file from Drive.
func DeleteFile(ctx context.Context, client *http.Client, fileID string) error {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return fmt.Errorf("drive service: %w", err)
	}
	if err := svc.Files.Delete(fileID).Context(ctx).Do(); err != nil {
		return fmt.Errorf("deleteFile: %w", err)
	}
	return nil
}

// ShareDoc sets the output doc permission (reader/commenter/writer) for anyone.
func ShareDoc(ctx context.Context, client *http.Client, docID, permission string) error {
	svc, err := newDriveService(ctx, client)
	if err != nil {
		return fmt.Errorf("drive service: %w", err)
	}
	_, err = svc.Permissions.Create(docID, &drive.Permission{
		Role: permission,
		Type: "anyone",
	}).Context(ctx).Do()
	if err != nil {
		return fmt.Errorf("shareDoc: %w", err)
	}
	return nil
}

func mimeForImage(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".webp" {
		return "image/webp"
	}
	t := mime.TypeByExtension(ext)
	if t == "" {
		if ext == ".jpg" || ext == ".jpeg" {
			return "image/jpeg"
		}
		return "image/png"
	}
	return t
}
