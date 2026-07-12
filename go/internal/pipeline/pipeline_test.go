package pipeline

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"squish-to-approve/internal/config"
)

type mockRoundTripper struct {
	t            *testing.T
	requests     []string
	docContent   string
	forceFailure bool
}

func (m *mockRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	path := req.URL.Path
	m.requests = append(m.requests, req.Method+" "+path)

	if m.forceFailure {
		return &http.Response{
			StatusCode: http.StatusInternalServerError,
			Body:       io.NopCloser(bytes.NewBufferString(`{"error": "internal error"}`)),
			Header:     make(http.Header),
		}, nil
	}

	var respBody string
	status := http.StatusOK

	switch {
	// Folder creation or Image upload
	case req.Method == "POST" && strings.HasSuffix(path, "/files"):
		respBody = `{"id": "mock-folder-or-file-id"}`

	// Template copy
	case req.Method == "POST" && strings.Contains(path, "/files/") && strings.HasSuffix(path, "/copy"):
		respBody = `{"id": "mock-copied-doc-id"}`

	// Permission create
	case req.Method == "POST" && strings.Contains(path, "/files/") && strings.HasSuffix(path, "/permissions"):
		respBody = `{"id": "mock-permission-id"}`

	// Docs batch update
	case req.Method == "POST" && strings.Contains(path, "/documents/") && strings.HasSuffix(path, ":batchUpdate"):
		respBody = `{"documentId": "mock-copied-doc-id"}`

	// Fetch document body
	case req.Method == "GET" && strings.Contains(path, "/documents/"):
		respBody = m.docContent

	// Rename file
	case req.Method == "PATCH" && strings.Contains(path, "/files/"):
		respBody = `{"id": "mock-doc-id"}`

	default:
		return nil, fmt.Errorf("unhandled mock path: %s %s", req.Method, path)
	}

	resp := &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewBufferString(respBody)),
		Header:     make(http.Header),
	}
	resp.Header.Set("Content-Type", "application/json")
	return resp, nil
}

const mockDocJSON = `{
  "body": {
    "content": [
      {
        "startIndex": 1,
        "endIndex": 20,
        "paragraph": {
          "elements": [
            { "startIndex": 1, "textRun": { "content": "{{IMAGE_1}}\n" } }
          ]
        }
      },
      {
        "startIndex": 21,
        "endIndex": 40,
        "paragraph": {
          "elements": [
            { "startIndex": 21, "textRun": { "content": "{{IMAGE_2}}\n" } }
          ]
        }
      },
      {
        "startIndex": 41,
        "endIndex": 60,
        "paragraph": {
          "elements": [
            { "startIndex": 41, "textRun": { "content": "{{IMAGE_3}}\n" } }
          ]
        }
      },
      {
        "startIndex": 61,
        "endIndex": 80,
        "paragraph": {
          "elements": [
            { "startIndex": 61, "textRun": { "content": "{{IMAGE_4}}\n" } }
          ]
        }
      },
      {
        "startIndex": 81,
        "endIndex": 100,
        "paragraph": {
          "elements": [
            { "startIndex": 81, "textRun": { "content": "{{IMAGE_5}}\n" } }
          ]
        }
      },
      {
        "startIndex": 101,
        "endIndex": 120,
        "paragraph": {
          "elements": [
            { "startIndex": 101, "textRun": { "content": "{{IMAGE_6}}\n" } }
          ]
        }
      },
      {
        "startIndex": 121,
        "endIndex": 140,
        "paragraph": {
          "elements": [
            { "startIndex": 121, "textRun": { "content": "{{IMAGE_7}}\n" } }
          ]
        }
      },
      {
        "startIndex": 141,
        "endIndex": 160,
        "paragraph": {
          "elements": [
            { "startIndex": 141, "textRun": { "content": "{{IMAGE_8}}\n" } }
          ]
        }
      },
      {
        "startIndex": 161,
        "endIndex": 180,
        "paragraph": {
          "elements": [
            { "startIndex": 161, "textRun": { "content": "{{IMAGE_9}}\n" } }
          ]
        }
      },
      {
        "startIndex": 181,
        "endIndex": 200,
        "paragraph": {
          "elements": [
            { "startIndex": 181, "textRun": { "content": "{{IMAGE_10}}\n" } }
          ]
        }
      }
    ]
  }
}`

func TestPipelineE2E(t *testing.T) {
	cfg := &config.Config{
		GoogleClientID:      "mock-id",
		GoogleClientSecret:  "mock-secret",
		GoogleRefreshToken:  "mock-token",
		TemplateIDIG:        "tmpl-ig",
		TemplateIDIGFB:      "tmpl-ig-fb",
		OutputFolderID:      "default-out-folder",
		TriggerURL:          "instagram.com/p/",
		OutputDocPermission: "reader",
	}

	t.Run("successful pipeline execution", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
			"2.png": nil,
		})
		zipData, _ := os.ReadFile(zipPath)

		mockTransport := &mockRoundTripper{
			t:          t,
			docContent: mockDocJSON,
		}
		client := &http.Client{Transport: mockTransport}

		input := Input{
			MsgID:       "msg-123",
			ZipData:     zipData,
			CaptionText: "Amazing Campaign\nBody details #tag1",
		}

		res, err := Run(context.Background(), cfg, client, input)
		if err != nil {
			t.Fatalf("unexpected pipeline failure: %v", err)
		}

		if res.DocName != "[APPROVAL | GRAPHICS] Amazing Campaign" {
			t.Errorf("expected doc name '[APPROVAL | GRAPHICS] Amazing Campaign', got %q", res.DocName)
		}

		// Ensure correct template was copied (tmpl-ig-fb since no trigger URL in caption)
		copiedTemplate := false
		for _, req := range mockTransport.requests {
			if strings.Contains(req, "/files/tmpl-ig-fb/copy") {
				copiedTemplate = true
			}
		}
		if !copiedTemplate {
			t.Error("expected tmpl-ig-fb template copy to be triggered")
		}
	})

	t.Run("switches template on trigger URL", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
		})
		zipData, _ := os.ReadFile(zipPath)

		mockTransport := &mockRoundTripper{
			t:          t,
			docContent: mockDocJSON,
		}
		client := &http.Client{Transport: mockTransport}

		input := Input{
			MsgID:       "msg-456",
			ZipData:     zipData,
			CaptionText: "Triggered Campaign\nLink: instagram.com/p/",
		}

		_, err := Run(context.Background(), cfg, client, input)
		if err != nil {
			t.Fatalf("unexpected pipeline failure: %v", err)
		}

		// Ensure IG-only template was copied (tmpl-ig)
		copiedTemplate := false
		for _, req := range mockTransport.requests {
			if strings.Contains(req, "/files/tmpl-ig/copy") {
				copiedTemplate = true
			}
		}
		if !copiedTemplate {
			t.Error("expected tmpl-ig template copy to be triggered")
		}
	})

	t.Run("rejects empty caption title", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
		})
		zipData, _ := os.ReadFile(zipPath)

		client := &http.Client{Transport: &mockRoundTripper{t: t}}

		input := Input{
			MsgID:       "msg-789",
			ZipData:     zipData,
			CaptionText: "\nNo title on first line",
		}

		_, err := Run(context.Background(), cfg, client, input)
		if err == nil {
			t.Fatal("expected error for empty title, got nil")
		}
		if !strings.Contains(err.Error(), "⚠️ The caption needs a title") {
			t.Errorf("expected caption error, got %v", err)
		}
	})

	t.Run("handles Google API errors gracefully", func(t *testing.T) {
		zipPath := makeTestZip(t, map[string][]byte{
			"1.png": nil,
		})
		zipData, _ := os.ReadFile(zipPath)

		mockTransport := &mockRoundTripper{
			t:            t,
			forceFailure: true,
		}
		client := &http.Client{Transport: mockTransport}

		input := Input{
			MsgID:       "msg-999",
			ZipData:     zipData,
			CaptionText: "Broken API\nTesting error handling",
		}

		_, err := Run(context.Background(), cfg, client, input)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !strings.Contains(err.Error(), "❌ Couldn't create the campaign folder") {
			t.Errorf("expected clean user message, got %v", err)
		}
	})
}
