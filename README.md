# approve-to-squish

WhatsApp → Google Docs carousel approval automation, rewritten in Go.

Send a `.zip` of carousel images + a caption to your WhatsApp bot and receive a filled-out Google Docs approval document in return.

---

## Setup

### 1. Go Environment

Ensure you have Go installed (version >= 1.25):

```bash
go version
```

You also need a C compiler (`gcc` or similar) installed on your host system as CGo is required to compile the SQLite auth backend (`go-sqlite3`).

### 2. Google Cloud project

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable **Google Docs API** and **Google Drive API**
3. Create OAuth 2.0 credentials (type: Web application), and add `http://localhost:3000/callback` as an authorised redirect URI.
4. Copy the client ID and secret into `.env`

### 3. Get a refresh token

```bash
cp .env.example .env
# Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
cd go && go build -o ../bin/auth-google ./cmd/auth-google/
cd .. && ./bin/auth-google
# Open the printed URL, authorise, copy the refresh token into .env
```

### 4. Create Drive resources

- Create two Google Docs templates (see template setup below) and paste their IDs into `.env` as `TEMPLATE_ID_IG` and `TEMPLATE_ID_IG_FB`
- Create a Drive folder for campaign output → `OUTPUT_FOLDER_ID` (a subfolder per campaign is created here automatically)

### 5. Template setup

Both templates must use these exact placeholders:

| Placeholder | Value |
|---|---|
| `{{TITLE}}` | Carousel title |
| `{{CAPTION}}` | Caption body (no hashtags) |
| `{{HASHTAGS}}` | Space-joined hashtag list |
| `{{NUMBER_OF_POSTS}}` | Number of images in the carousel |
| `{{IMAGE_1}}` … `{{IMAGE_10}}` | Inline image per slide |

Each `{{IMAGE_N}}` must be in its own deletable block (a standalone paragraph or a single table row). Unused image slots are deleted entirely, so verify that removing any block leaves the document readable.

The only difference between the two templates is the Platform field:
- `TEMPLATE_ID_IG` → Instagram only (selected when caption body **contains** `TRIGGER_URL`)
- `TEMPLATE_ID_IG_FB` → Instagram + Facebook (selected when caption body does **not** contain `TRIGGER_URL`)

### 6. Fill in the rest of .env

```
ALLOWED_JIDS=94721470618@s.whatsapp.net,48043604889668@lid   # your number or linked devices
TRIGGER_URL=sincerely.aiesec.lk                             # substring that flips to IG-only template
```

### 7. Deploy with Docker

The image is built locally on the VPS — nothing is pushed to a registry.

**Requirements:** Docker + Docker Compose (v2) installed on the host.

```bash
git clone <repo-url> ~/squish-to-approve
cd ~/squish-to-approve
cp .env.example .env   # fill in all values
sudo docker compose up -d --build
```

On first start, watch logs for the WhatsApp pairing code:

```bash
sudo docker compose logs -f
# WhatsApp → Linked Devices → Link with phone number → enter the code
```

The session and SQLite DB are stored in a named Docker volume (`squish-to-approve_bot_data`) and survive container restarts and image rebuilds.

#### Updates (pull new code)

```bash
git pull
sudo docker compose up -d --build
```

Rebuilds the image and restarts the container. The volume — and your WhatsApp session — is untouched.

#### Reset / switch to a new WhatsApp number

```bash
sudo docker compose down
sudo docker volume rm squish-to-approve_bot_data
sudo docker compose up -d
sudo docker compose logs -f   # grab the new pairing code
```

#### Other useful commands

```bash
sudo docker compose ps          # container status
sudo docker compose logs -f     # live logs
sudo docker compose down        # stop and remove container (volume kept)
```

### 8. Deploy with systemd (Alternative to Docker)

If you prefer to run the binary directly on the host system without Docker:

1. **Build the binary**:
   ```bash
   cd go && go build -o ../bin/squish-bot ./cmd/bot/
   ```
2. **Run manually first** to pair your WhatsApp:
   ```bash
   cd .. && ./bin/squish-bot
   # Enter the pairing code on your phone
   # Press Ctrl+C once paired and connected
   ```
3. **Configure systemd service**:
   Create `/etc/systemd/system/squish-bot.service`:
   ```ini
   [Unit]
   Description=WhatsApp to Google Docs Carousel Bot
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/squish-to-approve
   ExecStart=/home/ubuntu/squish-to-approve/bin/squish-bot
   Restart=always
   RestartSec=5
   EnvironmentFile=/home/ubuntu/squish-to-approve/.env

   [Install]
   WantedBy=multi-user.target
   ```
4. **Enable and start the service**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable squish-bot
   sudo systemctl start squish-bot
   ```

To check logs or status:
```bash
sudo systemctl status squish-bot
sudo journalctl -u squish-bot -f
```

#### Reset / switch to a new WhatsApp number (systemd)

```bash
sudo systemctl stop squish-bot
rm ./data/whatsmeow.db
./bin/squish-bot              # run manually to link new number, then Ctrl+C
sudo systemctl start squish-bot
```

---

## Usage

Send a WhatsApp message containing:
- A `.zip` file named so its images are `1.jpg`, `2.png`, etc. (1–10 images)
- A caption with the title on the first line, hashtags anywhere after line 1

You can send them together (zip with caption field) or separately within 2 minutes.

The bot replies with the Google Docs URL and the campaign folder URL when done, or a clear error message if something went wrong.

---

## Project layout

```
go/
  cmd/
    bot/
      main.go               entrypoint
    auth-google/
      main.go               one-time OAuth consent flow CLI
  internal/
    config/
      config.go             manual env validation/parsing
    google/
      auth.go               OAuth2 token retrieval
      drive.go              drive folder, upload, and sharing operations
      docs.go               filling doc with text and sequential images
    pipeline/
      pipeline.go           pipeline orchestrator (parallel uploads)
      parsetext.go          title and hashtag parser
      zip.go                zip extraction and index-based validation
      cleanup.go            temporary directory cleanup
  README.md
data/
  whatsmeow.db              SQLite database for whatsmeow credentials (gitignored)
```