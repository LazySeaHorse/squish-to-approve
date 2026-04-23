# LLM-START-HERE.md

Context document for AI coding agents. Read this before touching any file.

---

## What this project does

Single-user WhatsApp bot. The operator forwards a `.zip` of carousel images + a caption text to their own linked WhatsApp number. The bot produces a filled Google Docs approval document and replies with the link. No human pipeline management — just send, get link, share with approver.

---

## High-level flow

```
WhatsApp message
  → client.ts       detect zip / caption, pair them if split across messages
  → pipeline/       download zip, validate, parse text, upload images, copy+fill doc
  → Google Drive    copyTemplate → uploadImage × N → deleteImage × N (cleanup)
  → Google Docs     batchUpdate (text) + sequential batchUpdate × 10 (images)
  → WhatsApp reply  URL or error message
```

---

## File map

| File | What it does |
|---|---|
| `src/index.ts` | Entrypoint. Calls `connect()`, attaches unhandled-rejection logger. |
| `src/config.ts` | Parses and validates all env vars with Zod. Process exits immediately on misconfiguration. Single import for all config across the app. |
| `src/logger.ts` | Thin wrapper around `console.log/warn/error` with ISO timestamps. |
| `src/whatsapp/client.ts` | Entire WhatsApp layer: Baileys socket setup, reconnect logic, JID whitelist, message routing, pairing buffer. See "Pairing buffer" section below. |
| `src/whatsapp/sqliteAuthState.ts` | Baileys auth state backed by SQLite instead of files. See "SQLite auth state" section below. |
| `src/pipeline/index.ts` | Orchestrates the full pipeline for one request. The only place that knows the end-to-end order of operations. Returns `{ ok: true, url }` or `{ ok: false, userMessage }`. |
| `src/pipeline/parseText.ts` | Pure function. Splits raw caption string into `{ title, captionBody, hashtags[] }`. No side effects. |
| `src/pipeline/zip.ts` | Validates and extracts a zip file using `adm-zip`. Returns either `{ files: string[] }` (sorted image paths) or `{ kind, message }` error. |
| `src/pipeline/cleanup.ts` | Deletes temp Drive files and local temp dir. Always called in a `finally` block. |
| `src/google/auth.ts` | Returns a configured `OAuth2Client` with the refresh token set. Called on every request — tokens are fetched/refreshed lazily by the Google SDK. |
| `src/google/drive.ts` | `copyTemplate`, `uploadImage`, `shareDoc`, `deleteFile`. All Drive operations. |
| `src/google/docs.ts` | `fillDoc` — the most complex function. Two-phase doc filling. See "Doc filling" section below. |
| `scripts/auth-google.ts` | One-time OAuth consent flow. Starts a localhost:3000 HTTP server, catches the callback, prints the refresh token. Run once with `npm run auth:google`. |

---

## Key design decisions

### Why SQLite auth state instead of `useMultiFileAuthState`

Baileys' built-in `useMultiFileAuthState` creates one JSON file per signal key — this can reach thousands of files for an active session. We implemented `useSqliteAuthState` (single `auth_state` table, `key TEXT PRIMARY KEY, value TEXT`) using `better-sqlite3`. The logic is structurally identical to the Baileys built-in: same `BufferJSON` serialisation, same `app-state-sync-key` protobuf reconstruction, same `fixKey` slash/colon sanitisation. `saveCreds` is synchronous here (better-sqlite3 is sync-only), which is fine — Baileys calls it on credential updates.

No published SQLite auth-state npm package was available at time of writing. We own this code in `sqliteAuthState.ts`.

### Why the pairing buffer stores the raw `WAMessage` instead of the downloaded buffer

The user might send a zip and then type the caption seconds later. An earlier design downloaded the zip eagerly (before the caption arrived) and stored the `Buffer`. This introduced a race: if the caption arrived before the download finished, `processWithBuffers` would get an empty buffer. The fix was to store the raw `WAMessage` object and download only when both halves are paired — at that point we have the full message metadata needed for `downloadMediaMessage`.

The pairing buffer lives in `client.ts` as an in-memory `Map<jid, Pending>`. A 2-minute `setTimeout` per entry expires unpaired halves.

### Why browser string is `Browsers.ubuntu('Chrome')` and not `macOS('Desktop')`

WhatsApp's servers reject pairing code requests from unrecognized client fingerprints. `Browsers.macOS('Desktop')` produces a vague tuple that WhatsApp flags as suspicious. The fix is `Browsers.ubuntu('Chrome')`, which generates a Chrome-like user agent that WhatsApp accepts for phone-number authentication. This is Baileys' documented approach for pairing codes.

Also: the `requestPairingCode` call must happen in the `connection.update` event handler when the `qr` signal fires — not immediately after socket creation. The `qr` event indicates the WebSocket handshake with WhatsApp's servers is complete and they're ready for authentication. Calling too early (before WS is ready) fails with 428 Precondition Required.

### Why image slots are processed 10 → 1 (reverse order) sequentially with re-fetch

The Google Docs API works on character indices. When you delete or insert content, all indices after that point shift. Processing image slots from 10 down to 1 would preserve earlier indices if we processed them in one batched update — *but* the delete-block and insert-image operations in Phase B change document length unpredictably (images have variable sizes). Rather than track shifting offsets manually, we re-fetch `documents.get` before each slot. It costs ~10 extra API calls but is bulletproof. This was an explicit tradeoff in the original spec: "Start with sequential; optimize only if it's too slow."

### Why two template IDs instead of one

The IG-only vs IG+Facebook distinction is a "Platform" smart-chip dropdown in Google Docs — it cannot be set via the Docs API (smart chips are not exposed as `batchUpdate` operations). The only way to pre-set it is to have two separate template documents with the field already filled. Template selection is driven by `captionBody.includes(TRIGGER_URL)`.

### Why we upload images to Drive before inserting them into Docs

The Docs API `insertInlineImage` takes a URI, not raw bytes. The URI must be publicly readable when the Docs API fetches it. We upload each image to `TEMP_IMAGE_FOLDER_ID`, set `{ role: reader, type: anyone }` permission, and pass `https://drive.google.com/uc?id=<id>`. These files are deleted in the `finally` block.

> **Open item:** if the Docs API rejects `drive.google.com/uc?id=` links (this has varied across API versions), try the `webContentLink` from the Drive upload response instead. Verify empirically.

---

## Doc filling in detail (`src/google/docs.ts`)

`fillDoc(docId, title, captionBody, hashtags, images[])` runs in two phases:

**Phase A — text (one batchUpdate, three replaceAllText):**
- `{{TITLE}}` → title
- `{{CAPTION}}` → captionBody
- `{{HASHTAGS}}` → hashtags joined by spaces

**Phase B — images (loop from slot 10 down to 1):**

For each slot N:
1. Call `documents.get` to get fresh character indices.
2. If `images[N-1]` exists (slot is used):
   - Find the exact range of the `{{IMAGE_N}}` placeholder text.
   - `deleteContentRange` on that range, then `insertInlineImage` at the same start index.
3. If `images[N-1]` is undefined (slot is unused):
   - Find the range of the **entire block** (paragraph or table row) containing `{{IMAGE_N}}`.
   - `deleteContentRange` on the full block.

**Why the block deletion matters:** unused image slots should vanish cleanly, taking their "Slide N:" label with them. The template must be set up so each slot and its label share one deletable unit (a standalone paragraph or a single table row). The `findBlockRange` function in `docs.ts` handles both cases.

---

## Caption parsing rules (`src/pipeline/parseText.ts`)

Given raw input:
```
This is the title
Caption line one
Caption line two
#hashtag1 #hashtag2
```

- **Title:** everything before the first `\n`, trimmed.
- **Hashtags:** all `/#[\w]+/g` matches from the body (everything after line 1), deduplicated in order.
- **Caption body:** body with hashtag tokens stripped, trailing whitespace trimmed per line, runs of 3+ consecutive newlines collapsed to 2.

Edge case: if there is no `\n` in the input, the entire text is treated as the title, hashtags are extracted from it, and `captionBody` is empty. The pipeline then checks `title` is non-empty and rejects if not.

---

## Zip validation rules (`src/pipeline/zip.ts`)

Checked in order, first failure wins:
1. Zero entries → `empty`
2. > 10 entries → `too_many`
3. Any non-image extension → `non_image_files`
4. Any filename not matching `/^0*(\d+)\.(jpg|jpeg|png)$/i` → `wrong_naming`
5. Numeric parts are not consecutive starting at 1 → `missing_numbers`

On success, returns `files[]` sorted by numeric index. The numeric sort is important — filesystem order from the zip is not guaranteed.

---

## Environment variables

All required. Parsed in `src/config.ts`. See `.env.example` for the full list with comments.

| Variable | Purpose |
|---|---|
| `ALLOWED_JIDS` | Comma-separated. Only messages from these JIDs are processed. Set to your own number. |
| `BAILEYS_DB_PATH` | Path to the SQLite auth database. Default: `./data/baileys.db`. |
| `GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN` | OAuth2 credentials. Refresh token obtained via `npm run auth:google`. |
| `TEMPLATE_ID_IG / TEMPLATE_ID_IG_FB` | Google Doc IDs of the two templates. |
| `OUTPUT_FOLDER_ID` | Drive folder where filled approval docs are saved. |
| `TEMP_IMAGE_FOLDER_ID` | Drive folder for transient image uploads (deleted after each run). |
| `TRIGGER_URL` | Substring in caption body that selects the IG+FB template. |
| `OUTPUT_DOC_PERMISSION` | `reader` or `writer` — the permission set on the output doc. |
| `PAIRING_TIMEOUT_MS` | How long to wait for the other half of a split zip+caption. Default: 120000. |

---

## Build and run

```bash
npm ci
npm run build           # tsc → dist/
npm start               # node dist/src/index.js
npm run dev             # ts-node (no build step, for local dev)
npm run auth:google     # one-time Google OAuth flow
```

Compiled output lands in `dist/src/` and `dist/scripts/` (not `dist/` directly, because `rootDir` is `./` to accommodate both `src/` and `scripts/`).

**pm2:**
```bash
pm2 start ecosystem.config.js
pm2 logs approve-to-squish   # watch for QR code on first run
```

---

## What to watch out for when making changes

- **`docs.ts` Phase B:** any change to how indices are calculated must account for the re-fetch loop. Do not try to batch all 10 slots into one update without careful offset tracking.
- **`sqliteAuthState.ts`:** `saveCreds` is synchronous (better-sqlite3). Baileys expects it to return `void | Promise<void>`. Returning `void` is fine. Do not make it async without testing — async `saveCreds` with better-sqlite3 will not work.
- **`client.ts` pairing buffer:** the buffer is keyed by JID (sender), not message ID. One JID can only have one pending half at a time. Sending a second zip before the first is paired will replace the pending zip entry (the timer is reset).
- **Template placeholders:** `{{IMAGE_1}}` through `{{IMAGE_10}}` must be in the template as literal text, each in its own cleanly deletable block. If any placeholder is missing, `fillDoc` logs a warning and skips it — it will not throw. Missing image in the output doc is a template setup issue, not a code bug.
- **Google API quotas:** `documents.get` is called once per slot in Phase B (up to 10 calls per run). At low volume this is fine. If throughput ever matters, switch to a single `documents.get` + batched updates with manually adjusted indices.
