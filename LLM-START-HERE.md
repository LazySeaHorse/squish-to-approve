# LLM-START-HERE.md

Context document for AI coding agents. Read this before touching any file.

---

## What this project does

Single-user WhatsApp bot. The operator forwards a `.zip` of carousel images + a caption text to their own linked WhatsApp number. The bot produces a filled Google Docs approval document and replies with the link. No human pipeline management — just send, get link, share with approver.

---

## High-level flow

```
WhatsApp message
  → go/internal/whatsapp/client.go    detect zip / caption, pair them if split across messages
  → go/internal/pipeline/             download zip, validate, parse text, create campaign folder
  → Google Drive                      createFolder(title) → uploadImage × N → copyTemplate
  → Google Docs                       batchUpdate (text + NUMBER_OF_POSTS) + sequential batchUpdate × 10 (images)
  → Google Drive                      renameFile → doc becomes "[APPROVAL | GRAPHICS] {title}"
  → WhatsApp reply                    doc name + doc URL + campaign folder URL, or error message
```

Output structure:
```
OUTPUT_FOLDER_ID/
  {campaign_title}/
    [APPROVAL | GRAPHICS] {title} (Google Doc)
    1.jpg, 2.jpg, … (images)
```

---

## File map

| File / Folder | What it does |
|---|---|
| `go/cmd/bot/main.go` | Entrypoint. Loads config, initializes clients, starts WhatsApp loop, handles graceful shutdown. |
| `go/cmd/auth-google/main.go` | One-time OAuth consent flow. Starts a localhost:3000 HTTP server, catches the callback, prints the refresh token. |
| `go/internal/config/config.go` | Parses and validates all env vars from `.env` using manual validation. Exits on failure. |
| `go/internal/whatsapp/client.go` | WhatsApp layer using `whatsmeow`: session initialization, JID whitelist, message routing, pairing buffers, and command handling. |
| `go/internal/pipeline/pipeline.go` | Orchestrates the full pipeline for one request. Parallel uploads via Goroutines + WaitGroup. |
| `go/internal/pipeline/parsetext.go` | Splits raw caption string into `{ title, captionBody, hashtags[] }`. |
| `go/internal/pipeline/zip.go` | Validates and extracts a zip file. Accepts files matching `1.jpg`, `dives (1).png`, etc. |
| `go/internal/pipeline/cleanup.go` | Deletes temporary local folders. |
| `go/internal/google/auth.go` | Returns a configured OAuth2-capable `*http.Client` using `golang.org/x/oauth2`. |
| `go/internal/google/drive.go` | `CreateFolder`, `CopyTemplate`, `UploadImage`, `RenameFile`, `DeleteFile`, `ShareDoc` implementation. |
| `go/internal/google/docs.go` | `FillDoc` — Phase A (text replacements) and Phase B (sequential slot-by-slot image insertion). |

---

## Key design decisions

### Why whatsmeow with SQLite auth state

We use `go.mau.fi/whatsmeow` for WhatsApp. Session storage is handled via `whatsmeow/store/sqlstore` using `database/sql` backed by SQLite at `data/whatsmeow.db`. Unlike Baileys which required custom SQLite serialization code, `whatsmeow` manages its own SQL schema out of the box.

### Why the pairing buffer stores raw messages instead of buffers

The user might send a zip and then type the caption seconds later. The pairing buffer stores the raw `*events.Message` object (or the raw caption text string) and downloads the zip only when both halves are successfully paired.

The pairing buffer uses dual queues per state key (FIFO) to handle interleaved arrivals. Each queue item has a `context.CancelFunc` and a timer that expires after `PAIRING_TIMEOUT_MS`.

### Batch mode and commands

The bot has two operating modes controlled by user commands:
- **Single mode** (default): each completed pair is processed immediately.
- **Batch mode** (`/batch`): completed pairs are queued in `readyJobs[]`. The user sends `/go` to see a preview, then `/ok` to process sequentially, or `/cancel` to abort.

The state machine per JID has four states: `single`, `batch-idle`, `batch-confirming`, and `processing`.
During `processing`, new messages and mode-switching commands are blocked.
Batch processing is sequential (`for` loop) to keep RAM usage low (512 MB VPS) and avoid resource exhaustion.
Zips in batch mode are spooled to `data/batch-spool/` immediately after pairing to save memory, and deleted upon completion or cancellation.

Full command list: `/help`, `/batch`, `/single`, `/go`, `/ok`, `/cancel`.

### Why browser string is `PairClientChrome` ("Chrome (Linux)")

WhatsApp's servers reject pairing code requests from unrecognized client fingerprints. We request pairing via `PairClientChrome` and display name `"Chrome (Linux)"` to match typical browser targets.

### Why image slots are processed 10 → 1 (reverse order) sequentially with re-fetch

The Google Docs API works on character indices. When content is inserted or deleted, all indices after that point shift. To avoid tracking shifting offsets manually, we re-fetch the document via `documents.get` before each slot. It costs ~10 extra API calls but is bulletproof.

### Why two template IDs instead of one

The IG-only vs IG+Facebook distinction is a "Platform" smart-chip dropdown in Google Docs, which cannot be set via the Docs API. Therefore, we keep two template files. Template selection is driven by `captionBody.includes(TRIGGER_URL)`: URL found → `TEMPLATE_ID_IG`; URL absent → `TEMPLATE_ID_IG_FB`.

### Why we upload images to Drive before inserting them into Docs

The Docs API `insertInlineImage` takes a public URI. We upload each image to the campaign folder, grant public read permissions, and pass `https://drive.google.com/uc?id=<id>` to the Docs API.

---

## Build and run

```bash
# Build binary
cd go && go build -o ../bin/squish-bot ./cmd/bot/

# Run locally
./bin/squish-bot

# Run auth helper
cd go && go build -o ../bin/auth-google ./cmd/auth-google/
./bin/auth-google
```

---

## What to watch out for when making changes

- **`docs.go` Phase B:** any change to how indices are calculated must account for the re-fetch loop. When deleting a full block, the final newline character must be excluded (`endIndex - 1`), otherwise the Google Docs API will reject the request.
- **LID and linked device JIDs:** whatsmeow parses JIDs into `types.JID` objects. Always use `.ToNonAD()` to normalise JIDs for state mapping, and check alternative addresses (e.g. `SenderAlt` or JID user + `@lid`) to verify allowed users.
- **Go toolchain:** whatsmeow requires Go >= 1.25. Ensure the toolchain on the VPS is up-to-date. CGo (`gcc`) is required for building `go-sqlite3`.
- **Zip processing:** zip extraction silently filters to root-level image files only, skipping macOS metadata or subdirectories.
