package whatsapp

import (
	"strings"
	"testing"

	"squish-to-approve/internal/config"
)

func TestClientCommands(t *testing.T) {
	cfg := &config.Config{
		OutputFolderID: "default-folder-id",
	}

	var sentJID, sentText string
	client := &Client{
		cfg: cfg,
		sendTextFn: func(jid, text string) {
			sentJID = jid
			sentText = text
		},
	}

	replyJID := "user-123"
	stateKey := "user-123"

	t.Run("/help command shows instruction text", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/help")

		if sentJID != replyJID {
			t.Errorf("expected JID %q, got %q", replyJID, sentJID)
		}
		if !strings.Contains(sentText, "*Commands*") {
			t.Errorf("expected help text, got %q", sentText)
		}
	})

	t.Run("/info command shows single mode and default folder", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/info")

		if !strings.Contains(sentText, "Mode: *single*") {
			t.Errorf("expected single mode, got %q", sentText)
		}
		if !strings.Contains(sentText, "default-folder-id") {
			t.Errorf("expected default folder, got %q", sentText)
		}
	})

	t.Run("/folder updates target folder override", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/folder overridden-folder-id")

		if !strings.Contains(sentText, "overridden-folder-id") {
			t.Errorf("expected confirmation of override, got %q", sentText)
		}

		s := client.getState(stateKey)
		s.mu.Lock()
		folderID := s.outputFolderID
		s.mu.Unlock()
		if folderID != "overridden-folder-id" {
			t.Errorf("expected override ID to be set, got %q", folderID)
		}
	})

	t.Run("/folder with URL extracts raw ID", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/folder https://drive.google.com/drive/folders/url-folder-id?usp=sharing")

		if !strings.Contains(sentText, "url-folder-id") {
			t.Errorf("expected confirmation of extracted override ID, got %q", sentText)
		}

		s := client.getState(stateKey)
		s.mu.Lock()
		folderID := s.outputFolderID
		s.mu.Unlock()
		if folderID != "url-folder-id" {
			t.Errorf("expected extracted ID, got %q", folderID)
		}
	})

	t.Run("/folder resets override when no arg is provided", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/folder")

		if !strings.Contains(sentText, "default-folder-id") {
			t.Errorf("expected confirmation of reset to default, got %q", sentText)
		}

		s := client.getState(stateKey)
		s.mu.Lock()
		folderID := s.outputFolderID
		s.mu.Unlock()
		if folderID != "" {
			t.Errorf("expected override ID to be cleared, got %q", folderID)
		}
	})

	t.Run("/batch switches state to batch-idle", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/batch")

		if !strings.Contains(sentText, "Batch mode on") {
			t.Errorf("expected batch-idle transition confirmation, got %q", sentText)
		}

		s := client.getState(stateKey)
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode != stateBatchIdle {
			t.Errorf("expected stateBatchIdle, got %v", mode)
		}
	})

	t.Run("/single switches state to single", func(t *testing.T) {
		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/single")

		if !strings.Contains(sentText, "Single mode on") {
			t.Errorf("expected single transition confirmation, got %q", sentText)
		}

		s := client.getState(stateKey)
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode != stateSingle {
			t.Errorf("expected stateSingle, got %v", mode)
		}
	})

	t.Run("blocks batch command transitions when confirming", func(t *testing.T) {
		s := client.getState(stateKey)
		s.mu.Lock()
		s.mode = stateBatchConfirming
		s.mu.Unlock()

		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/batch")

		if !strings.Contains(sentText, "⚠️ You have a pending /go preview") {
			t.Errorf("expected pending preview warning, got %q", sentText)
		}
	})

	t.Run("/cancel resets state when confirming", func(t *testing.T) {
		s := client.getState(stateKey)
		s.mu.Lock()
		s.mode = stateBatchConfirming
		s.mu.Unlock()

		sentJID, sentText = "", ""
		client.handleCommand(replyJID, stateKey, "/cancel")

		if !strings.Contains(sentText, "🗑 Cleared") {
			t.Errorf("expected cancellation confirmation, got %q", sentText)
		}

		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode != stateBatchIdle {
			t.Errorf("expected rollback to batch-idle, got %v", mode)
		}
	})
}
