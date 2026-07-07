# Squish-to-approve Go bot

## Quick start

```bash
# Build (requires GCC for go-sqlite3 CGo)
cd go && go build -o ../bin/squish-bot ./cmd/bot/

# Run (reads .env from the project root)
cd /home/ubuntu/squish-to-approve && ./bin/squish-bot
```

## One-time Google auth (if refresh token needs renewal)

```bash
cd go && go build -o ../bin/auth-google ./cmd/auth-google/
cd .. && ./bin/auth-google
# Follow the URL, copy GOOGLE_REFRESH_TOKEN into .env
```

## Environment variables (same .env as the TS bot)

| Variable | Notes |
|---|---|
| `ALLOWED_JIDS` | Comma-separated. Supports `@s.whatsapp.net` and `@lid` |
| `WHATSMEOW_DB_PATH` | Default: `./data/whatsmeow.db` (different from Baileys DB!) |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | Unchanged from TS bot |
| `TEMPLATE_ID_IG`, `TEMPLATE_ID_IG_FB` | Unchanged |
| `OUTPUT_FOLDER_ID`, `TRIGGER_URL` | Unchanged |
| `OUTPUT_DOC_PERMISSION` | reader / commenter / writer |
| `PAIRING_TIMEOUT_MS` | Default 120000 |

## Switch-over from TS bot

1. `pm2 stop approve-to-squish`
2. `./bin/squish-bot` — prints pairing code
3. WhatsApp → Linked Devices → Link with phone number → enter code
4. Verify `/help` works
5. Kill the manual run, set up pm2 or systemd:

```bash
pm2 start bin/squish-bot --name squish-bot-go --interpreter none
# or
pm2 delete approve-to-squish
```

## Rollback

TS bot is fully intact in `src/`. Run `pm2 start ecosystem.config.js` to restore it.
The `.env` file is shared — no credential migration needed.
