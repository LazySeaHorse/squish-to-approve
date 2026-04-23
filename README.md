# approve-to-squish

WhatsApp → Google Docs carousel approval automation.

Send a `.zip` of carousel images + a caption to your WhatsApp bot and receive a filled-out Google Docs approval document in return.

## Setup

### 1. VPS / Node

```bash
node --version   # must be >= 20
npm ci
npm run build
```

### 2. Google Cloud project

1. Create a project at console.cloud.google.com
2. Enable **Google Docs API** and **Google Drive API**
3. Create OAuth 2.0 credentials (type: Web application), add `http://localhost:3000/oauth2callback` as an authorised redirect URI
4. Copy the client ID and secret into `.env`

### 3. Get a refresh token

```bash
cp .env.example .env
# Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
npm run auth:google
# Open the printed URL, authorise, copy the refresh token into .env
```

### 4. Create Drive resources

- Create two Google Docs templates (see template setup below) and paste their IDs into `.env` as `TEMPLATE_ID_IG` and `TEMPLATE_ID_IG_FB`
- Create a Drive folder for approval docs → `OUTPUT_FOLDER_ID`
- Create a Drive folder for temporary image uploads → `TEMP_IMAGE_FOLDER_ID`

### 5. Template setup

Both templates must use these exact placeholders:

| Placeholder | Value |
|---|---|
| `{{TITLE}}` | Carousel title |
| `{{CAPTION}}` | Caption body (no hashtags) |
| `{{HASHTAGS}}` | Space-joined hashtag list |
| `{{IMAGE_1}}` … `{{IMAGE_10}}` | Inline image per slide |

Each `{{IMAGE_N}}` must be in its own deletable block (a standalone paragraph or a single table row). Unused image slots are deleted entirely, so verify that removing any block leaves the document readable.

The only difference between the two templates is the Platform field:
- `TEMPLATE_ID_IG` → Instagram only
- `TEMPLATE_ID_IG_FB` → Instagram + Facebook (triggered when caption body contains `TRIGGER_URL`)

### 6. Fill in the rest of .env

```
ALLOWED_JIDS=447911123456@s.whatsapp.net   # your own number
TRIGGER_URL=instagram.com/p/               # substring that flips to IG+FB template
```

### 7. Deploy with pm2

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable autostart
```

On first start, watch logs for a QR code and link the bot from your phone:

```bash
pm2 logs approve-to-squish
```

## Usage

Send a WhatsApp message containing:
- A `.zip` file named so its images are `1.jpg`, `2.png`, etc. (1–10 images)
- A caption with the title on the first line, hashtags anywhere after line 1

You can send them together (zip with caption field) or separately within 2 minutes.

The bot replies with the Google Docs URL when done, or a clear error message if something went wrong.

## Project layout

```
src/
  index.ts                 entrypoint
  config.ts                env parsing (zod)
  logger.ts
  google/
    auth.ts                OAuth2 client
    drive.ts               file copy/upload/share/delete
    docs.ts                batchUpdate logic (text + images)
  pipeline/
    index.ts               orchestration
    zip.ts                 extract + validate
    parseText.ts           title/caption/hashtags parsing
    cleanup.ts             Drive + local temp cleanup
  whatsapp/
    client.ts              Baileys setup, message routing, pairing buffer
    sqliteAuthState.ts     SQLite-backed auth state (replaces multi-file state)
scripts/
  auth-google.ts           one-time OAuth consent flow
data/                      baileys.db lives here (gitignored)
```
