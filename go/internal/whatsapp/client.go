package whatsapp

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	"squish-to-approve/internal/config"
	"squish-to-approve/internal/pipeline"
)

const batchSpoolDir = "data/batch-spool"

// ── Types ─────────────────────────────────────────────────────────────────────

type clientState int

const (
	stateSingle clientState = iota
	stateBatchIdle
	stateBatchConfirming
	stateProcessing
)

// queuedJob is a fully paired job ready for processing in batch mode.
type queuedJob struct {
	msgID        string
	zipPath      string // path to spooled zip on disk
	captionText  string
	previewTitle string
	zipFileName  string
	imageCount   int
}

// timedItem wraps a queued half-pair with its expiry cancel func.
type timedItem[T any] struct {
	value  T
	cancel context.CancelFunc
}

// jidState holds all per-JID mutable state.
type jidState struct {
	mu              sync.Mutex
	mode            clientState
	pendingZips     []timedItem[*events.Message]
	pendingCaptions []timedItem[string]
	readyJobs       []queuedJob
}

// ── Client ────────────────────────────────────────────────────────────────────

// Client wraps a whatsmeow.Client and owns all bot logic.
type Client struct {
	wa         *whatsmeow.Client
	cfg        *config.Config
	httpClient *http.Client
	jidStates  sync.Map // map[string]*jidState
}

// New creates and connects a whatsmeow client.
func New(ctx context.Context, cfg *config.Config, httpClient *http.Client) (*Client, error) {
	if err := os.MkdirAll(filepath.Dir(cfg.WhatsmeowDBPath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?_foreign_keys=on&_journal_mode=WAL", cfg.WhatsmeowDBPath))
	if err != nil {
		return nil, fmt.Errorf("open whatsmeow db: %w", err)
	}

	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		return nil, fmt.Errorf("upgrade whatsmeow schema: %w", err)
	}

	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("get device store: %w", err)
	}

	wa := whatsmeow.NewClient(deviceStore, waLog.Noop)

	c := &Client{
		wa:         wa,
		cfg:        cfg,
		httpClient: httpClient,
	}

	wa.AddEventHandler(c.handleEvent)

	if wa.Store.ID == nil {
		// Not yet paired — connect first, then request pairing code
		if err := wa.Connect(); err != nil {
			return nil, fmt.Errorf("connect (pre-pair): %w", err)
		}
		phone := extractDigits(cfg.AllowedJIDs[0])
		code, err := wa.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			return nil, fmt.Errorf("pair phone: %w", err)
		}
		slog.Info("\n\n  WhatsApp pairing code: " + code + "\n\n  Open WhatsApp → Linked Devices → Link with phone number\n")
	} else {
		if err := wa.Connect(); err != nil {
			return nil, fmt.Errorf("connect: %w", err)
		}
	}

	return c, nil
}

// Disconnect cleanly disconnects the WhatsApp client.
func (c *Client) Disconnect() {
	c.wa.Disconnect()
}

// ── Event handler ─────────────────────────────────────────────────────────────

func (c *Client) handleEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Connected:
		slog.Info("WhatsApp connected ✓")

	case *events.Disconnected:
		slog.Warn("WhatsApp disconnected — reconnecting in 3s")
		go func() {
			time.Sleep(3 * time.Second)
			if err := c.wa.Connect(); err != nil {
				slog.Error("reconnect failed", "err", err)
			}
		}()

	case *events.LoggedOut:
		slog.Error("Logged out by WhatsApp — delete data/whatsmeow.db and restart to re-pair")
		os.Exit(1)

	case *events.Message:
		if v.Info.IsFromMe {
			return
		}
		go c.handleMessage(v)
	}
}

// ── Message handling ──────────────────────────────────────────────────────────

func (c *Client) handleMessage(msg *events.Message) {
	// Build JID strings for whitelist comparison.
	// msg.Info.Sender is the full AD JID (user@server/device).
	// ToNonAD() gives us user@server, which matches @s.whatsapp.net entries.
	// For @lid entries we compare msg.Info.Sender.User + "@lid".
	senderFull := msg.Info.Sender.String()
	senderNonAD := msg.Info.Sender.ToNonAD().String()
	senderLID := msg.Info.Sender.User + "@lid"
	// Also check the alternative address (SenderAlt) for linked devices
	senderAlt := msg.Info.SenderAlt.String()

	allowed := false
	for _, allowedJID := range c.cfg.AllowedJIDs {
		if allowedJID == senderFull || allowedJID == senderNonAD ||
			allowedJID == senderLID || allowedJID == senderAlt {
			allowed = true
			break
		}
	}
	if !allowed {
		slog.Info("message from non-allowed JID, ignoring", "jid", senderFull)
		return
	}

	// State key: use the non-AD JID so @lid and @s.whatsapp.net for the same
	// phone both map to the same jidState.
	stateKey := senderNonAD

	// Reply JID: use the Chat JID (which is the DM chat, i.e. the sender's JID
	// in 1:1 conversations). This is the correct target for SendMessage.
	replyJID := msg.Info.Chat.String()

	slog.Info("incoming message", "from", senderFull)

	m := msg.Message
	doc := getDoc(m)
	isZip := doc != nil && (
		strings.HasSuffix(strings.ToLower(doc.GetFileName()), ".zip") ||
		doc.GetMimetype() == "application/zip" ||
		doc.GetMimetype() == "application/x-zip-compressed")

	text := getText(m)

	s := c.getState(stateKey)

	// ── Command handling ──────────────────────────────────────────────────────
	if !isZip && strings.HasPrefix(text, "/") {
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()

		if mode == stateBatchConfirming {
			cmd := strings.ToLower(strings.TrimSpace(text))
			if cmd != "/ok" && cmd != "/cancel" && cmd != "/help" {
				c.sendText(replyJID, "⚠️ Awaiting confirmation. Send /ok to proceed or /cancel to abort.")
				return
			}
		}
		c.handleCommand(replyJID, stateKey, text)
		return
	}

	// ── Block content during confirming / processing ──────────────────────────
	s.mu.Lock()
	mode := s.mode
	s.mu.Unlock()

	if mode == stateBatchConfirming {
		c.sendText(replyJID, "⚠️ Awaiting confirmation. Send /ok to proceed or /cancel to abort.")
		return
	}
	if mode == stateProcessing {
		c.sendText(replyJID, "⏳ Currently processing a batch. Please wait.")
		return
	}

	// ── Zip / caption pairing ─────────────────────────────────────────────────
	if isZip {
		caption := strings.TrimSpace(doc.GetCaption())
		if caption != "" {
			slog.Info("zip+caption in one message", "from", senderFull)
			c.onPairCompleted(replyJID, stateKey, msg, caption)
		} else {
			if paired := c.storeZip(replyJID, stateKey, msg); paired != "" {
				c.onPairCompleted(replyJID, stateKey, msg, paired)
			} else {
				c.sendText(replyJID, "📦 Got the zip. Send the caption next.")
			}
		}
	} else if text != "" {
		if pairedMsg := c.storeCaption(replyJID, stateKey, text); pairedMsg != nil {
			c.onPairCompleted(replyJID, stateKey, pairedMsg, text)
		} else {
			c.sendText(replyJID, "📝 Got the caption. Send the zip next.")
		}
	}
}

// ── Per-JID state ─────────────────────────────────────────────────────────────

func (c *Client) getState(key string) *jidState {
	v, _ := c.jidStates.LoadOrStore(key, &jidState{mode: stateSingle})
	return v.(*jidState)
}

// ── Pairing buffer (dual FIFO queues) ─────────────────────────────────────────

// storeZip adds a zip message to the pending queue. If a caption is already
// waiting, pairs them immediately and returns the caption text.
func (c *Client) storeZip(replyJID, stateKey string, msg *events.Message) string {
	s := c.getState(stateKey)
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.pendingCaptions) > 0 {
		captionItem := s.pendingCaptions[0]
		s.pendingCaptions = s.pendingCaptions[1:]
		captionItem.cancel()
		return captionItem.value
	}

	ctx, cancel := context.WithCancel(context.Background())
	item := timedItem[*events.Message]{value: msg, cancel: cancel}
	s.pendingZips = append(s.pendingZips, item)

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.cfg.PairingTimeout):
			s2 := c.getState(stateKey)
			s2.mu.Lock()
			for i, it := range s2.pendingZips {
				if it.value == msg {
					s2.pendingZips = append(s2.pendingZips[:i], s2.pendingZips[i+1:]...)
					break
				}
			}
			s2.mu.Unlock()
			c.sendText(replyJID, "⏱ Timed out waiting for the other half. Send the zip and caption again.")
		}
	}()

	return ""
}

// storeCaption adds a caption to the pending queue. If a zip is already
// waiting, pairs them immediately and returns the zip event.
func (c *Client) storeCaption(replyJID, stateKey string, text string) *events.Message {
	s := c.getState(stateKey)
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.pendingZips) > 0 {
		zipItem := s.pendingZips[0]
		s.pendingZips = s.pendingZips[1:]
		zipItem.cancel()
		return zipItem.value
	}

	ctx, cancel := context.WithCancel(context.Background())
	item := timedItem[string]{value: text, cancel: cancel}
	s.pendingCaptions = append(s.pendingCaptions, item)

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.cfg.PairingTimeout):
			s2 := c.getState(stateKey)
			s2.mu.Lock()
			for i, it := range s2.pendingCaptions {
				if it.value == text {
					s2.pendingCaptions = append(s2.pendingCaptions[:i], s2.pendingCaptions[i+1:]...)
					break
				}
			}
			s2.mu.Unlock()
			c.sendText(replyJID, "⏱ Timed out waiting for the other half. Send the zip and caption again.")
		}
	}()

	return nil
}

func (c *Client) clearPendingBuffers(stateKey string) {
	s := c.getState(stateKey)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.pendingZips {
		item.cancel()
	}
	for _, item := range s.pendingCaptions {
		item.cancel()
	}
	s.pendingZips = nil
	s.pendingCaptions = nil
}

func cleanupSpooledZips(jobs []queuedJob) {
	for _, job := range jobs {
		if job.zipPath != "" {
			if err := os.Remove(job.zipPath); err != nil && !os.IsNotExist(err) {
				slog.Warn("failed to delete spooled zip", "path", job.zipPath)
			}
		}
	}
}

// ── Pair completion ───────────────────────────────────────────────────────────

func (c *Client) onPairCompleted(replyJID, stateKey string, msg *events.Message, captionText string) {
	// Download the zip — DownloadAny takes context in this API version
	zipData, err := c.wa.DownloadAny(context.Background(), msg.Message)
	if err != nil {
		slog.Error("failed to download zip", "err", err)
		c.sendText(replyJID, "❌ Failed to download the zip. Try sending it again.")
		return
	}

	doc := getDoc(msg.Message)
	zipFileName := "unknown.zip"
	if doc != nil {
		zipFileName = doc.GetFileName()
	}

	parsed := pipeline.ParseCaption(captionText)

	// Write to temp file to count images without full extraction
	tmpZip := filepath.Join(os.TempDir(), fmt.Sprintf("count-%s.zip", msg.Info.ID))
	_ = os.WriteFile(tmpZip, zipData, 0o600)
	imageCount := pipeline.CountImagesInZip(tmpZip)
	_ = os.Remove(tmpZip)

	if imageCount == 0 {
		c.sendText(replyJID, "❌ That zip file appears to be corrupt or empty. Try re-zipping and sending again.")
		return
	}

	s := c.getState(stateKey)
	s.mu.Lock()
	mode := s.mode
	s.mu.Unlock()

	if mode == stateSingle {
		c.sendText(replyJID, "⏳ Got both. Building the doc...")
		slog.Info("processing carousel", "replyJID", replyJID, "msgID", msg.Info.ID)
		result, err := pipeline.Run(context.Background(), c.cfg, c.httpClient, pipeline.Input{
			MsgID:       string(msg.Info.ID),
			ZipData:     zipData,
			CaptionText: captionText,
		})
		if err != nil {
			c.sendText(replyJID, err.Error())
		} else {
			c.sendText(replyJID, fmt.Sprintf("✅ %s\n\n%s\n\n📁 Campaign folder: %s",
				result.DocName, result.URL, result.FolderURL))
		}
	} else {
		// Batch mode — spool to disk
		if err := os.MkdirAll(batchSpoolDir, 0o755); err != nil {
			slog.Error("failed to create spool dir", "err", err)
			c.sendText(replyJID, "❌ Internal error: couldn't create spool directory.")
			return
		}
		spoolPath := filepath.Join(batchSpoolDir, string(msg.Info.ID)+".zip")
		if err := os.WriteFile(spoolPath, zipData, 0o644); err != nil {
			slog.Error("failed to write spool file", "err", err)
			c.sendText(replyJID, "❌ Internal error: couldn't spool the zip to disk.")
			return
		}

		job := queuedJob{
			msgID:        string(msg.Info.ID),
			zipPath:      spoolPath,
			captionText:  captionText,
			previewTitle: parsed.Title,
			zipFileName:  zipFileName,
			imageCount:   imageCount,
		}

		s.mu.Lock()
		s.readyJobs = append(s.readyJobs, job)
		jobCount := len(s.readyJobs)
		s.mu.Unlock()

		c.sendText(replyJID, fmt.Sprintf("📦 Pair queued (#%d): *%s* — %s",
			jobCount, orUntitled(parsed.Title), pluralImages(imageCount)))
	}
}

// ── Command handling ──────────────────────────────────────────────────────────

const helpText = `🤖 *Commands*

*/help* — Show this message
*/batch* — Switch to batch mode (queue pairs, process on /go)
*/single* — Switch to single mode (process each pair immediately)
*/go* — (Batch mode) Preview queued pairs
*/ok* — (After /go) Confirm and start processing
*/cancel* — Clear all queued pairs and pending halves

*Single mode (default):*
Send a zip + caption (together or separately). The doc is built immediately.

*Batch mode:*
1. Send /batch
2. Send your zip + caption pairs
3. Send /go to preview
4. Send /ok to process, or /cancel to abort`

func (c *Client) handleCommand(replyJID, stateKey, text string) {
	cmd := strings.ToLower(strings.TrimSpace(text))
	s := c.getState(stateKey)

	switch cmd {
	case "/help":
		c.sendText(replyJID, helpText)

	case "/batch":
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode == stateProcessing {
			c.sendText(replyJID, "⏳ Currently processing. Wait for it to finish.")
			return
		}
		if mode == stateBatchConfirming {
			c.sendText(replyJID, "⚠️ You have a pending /go preview. Send /ok or /cancel first.")
			return
		}
		s.mu.Lock()
		s.mode = stateBatchIdle
		s.mu.Unlock()
		c.sendText(replyJID, "📦 Batch mode on. Send your zip + caption pairs, then /go when ready.")

	case "/single":
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode == stateProcessing {
			c.sendText(replyJID, "⏳ Currently processing. Wait for it to finish.")
			return
		}
		if mode == stateBatchConfirming {
			c.sendText(replyJID, "⚠️ You have a pending /go preview. Send /ok or /cancel first.")
			return
		}
		c.clearPendingBuffers(stateKey)
		s.mu.Lock()
		s.readyJobs = nil
		s.mode = stateSingle
		s.mu.Unlock()
		c.sendText(replyJID, "🔁 Single mode on. Each pair will be processed immediately.")

	case "/go":
		s.mu.Lock()
		mode := s.mode
		jobs := make([]queuedJob, len(s.readyJobs))
		copy(jobs, s.readyJobs)
		s.mu.Unlock()

		if mode == stateProcessing {
			c.sendText(replyJID, "⏳ Already processing.")
			return
		}
		if mode != stateBatchIdle {
			c.sendText(replyJID, "⚠️ /go only works in batch mode. Send /batch first.")
			return
		}
		if len(jobs) == 0 {
			c.sendText(replyJID, "⚠️ No pairs queued yet. Send some zip + caption pairs first.")
			return
		}
		s.mu.Lock()
		s.mode = stateBatchConfirming
		s.mu.Unlock()

		lines := make([]string, len(jobs))
		for i, job := range jobs {
			lines[i] = fmt.Sprintf("%d. *%s*\n   📎 %s · %s",
				i+1, orUntitled(job.previewTitle), job.zipFileName, pluralImages(job.imageCount))
		}
		c.sendText(replyJID, fmt.Sprintf("📋 *%s queued:*\n\n%s\n\nSend /ok to process, or /cancel to abort.",
			pluralPairs(len(jobs)), strings.Join(lines, "\n\n")))

	case "/ok":
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode != stateBatchConfirming {
			c.sendText(replyJID, "⚠️ Nothing to confirm. Use /go first to preview your batch.")
			return
		}
		go c.processBatch(replyJID, stateKey)

	case "/cancel":
		s.mu.Lock()
		mode := s.mode
		s.mu.Unlock()
		if mode == stateProcessing {
			c.sendText(replyJID, "⏳ Can't cancel while processing. Wait for it to finish.")
			return
		}
		c.clearPendingBuffers(stateKey)
		s.mu.Lock()
		jobs := s.readyJobs
		s.readyJobs = nil
		prevMode := s.mode
		if prevMode == stateSingle {
			s.mode = stateSingle
		} else {
			s.mode = stateBatchIdle
		}
		s.mu.Unlock()
		cleanupSpooledZips(jobs)
		c.sendText(replyJID, "🗑 Cleared. All queued pairs and pending halves have been dropped.")
	}
}

// ── Batch processing ──────────────────────────────────────────────────────────

func (c *Client) processBatch(replyJID, stateKey string) {
	s := c.getState(stateKey)

	s.mu.Lock()
	jobs := make([]queuedJob, len(s.readyJobs))
	copy(jobs, s.readyJobs)
	s.readyJobs = nil
	s.mode = stateProcessing
	s.mu.Unlock()

	c.sendText(replyJID, fmt.Sprintf("⏳ Processing %s...", pluralPairs(len(jobs))))

	for i, job := range jobs {
		label := fmt.Sprintf("[%d/%d] %s", i+1, len(jobs), orUntitled(job.previewTitle))
		slog.Info("batch job starting", "label", label)

		zipData, err := os.ReadFile(job.zipPath)
		if err != nil {
			slog.Error("failed to read spooled zip", "path", job.zipPath, "err", err)
			c.sendText(replyJID, fmt.Sprintf("❌ %s\nFailed to read the zip from disk.", label))
			continue
		}

		result, err := pipeline.Run(context.Background(), c.cfg, c.httpClient, pipeline.Input{
			MsgID:       job.msgID,
			ZipData:     zipData,
			CaptionText: job.captionText,
		})
		if err != nil {
			c.sendText(replyJID, fmt.Sprintf("❌ %s\n%s", label, err.Error()))
		} else {
			c.sendText(replyJID, fmt.Sprintf("✅ %s\n%s\n\n%s\n\n📁 %s",
				label, result.DocName, result.URL, result.FolderURL))
		}
	}

	cleanupSpooledZips(jobs)

	s.mu.Lock()
	s.mode = stateBatchIdle
	s.mu.Unlock()

	c.sendText(replyJID, fmt.Sprintf("✅ Batch complete. %s processed.", pluralPairs(len(jobs))))
}

// ── Send ──────────────────────────────────────────────────────────────────────

func (c *Client) sendText(jid, text string) {
	jidParsed, err := types.ParseJID(jid)
	if err != nil {
		slog.Error("sendText: invalid JID", "jid", jid, "err", err)
		return
	}
	_, err = c.wa.SendMessage(context.Background(), jidParsed, &waE2E.Message{
		Conversation: &text,
	})
	if err != nil {
		slog.Error("sendText failed", "jid", jid, "err", err)
	}
}

// ── Utilities ─────────────────────────────────────────────────────────────────

func getDoc(m *waE2E.Message) *waE2E.DocumentMessage {
	if m == nil {
		return nil
	}
	return m.GetDocumentMessage()
}

func getText(m *waE2E.Message) string {
	if m == nil {
		return ""
	}
	if t := m.GetConversation(); t != "" {
		return t
	}
	return m.GetExtendedTextMessage().GetText()
}

func extractDigits(jid string) string {
	var b strings.Builder
	for _, r := range jid {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func orUntitled(s string) string {
	if s == "" {
		return "(untitled)"
	}
	return s
}

func pluralImages(n int) string {
	if n == 1 {
		return "1 image"
	}
	return fmt.Sprintf("%d images", n)
}

func pluralPairs(n int) string {
	if n == 1 {
		return "1 pair"
	}
	return fmt.Sprintf("%d pairs", n)
}
