import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import AdmZip from 'adm-zip';
import { useSqliteAuthState } from './sqliteAuthState';
import { runPipeline } from '../pipeline';
import { parseCaption } from '../pipeline/parseText';
import { config } from '../config';
import { logger } from '../logger';

let sock: WASocket | null = null;

async function sendText(jid: string, text: string): Promise<void> {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('Failed to send message:', err);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A fully paired job ready for processing. */
interface QueuedJob {
  zipMsg: WAMessage;
  zipBuffer: Buffer;
  captionText: string;
  /** Pre-parsed title for the /go preview. */
  previewTitle: string;
  /** Original zip filename from the WhatsApp message. */
  zipFileName: string;
  /** Number of root-level image entries in the zip (for /go preview). */
  imageCount: number;
}

type ClientState = 'single' | 'batch-idle' | 'batch-confirming' | 'processing';

// ── Per-JID state ─────────────────────────────────────────────────────────────

interface TimedItem<T> {
  value: T;
  timer: ReturnType<typeof setTimeout>;
}

interface JidState {
  mode: ClientState;
  pendingZips: Array<TimedItem<WAMessage>>;
  pendingCaptions: Array<TimedItem<string>>;
  readyJobs: QueuedJob[];
}

const jidStates = new Map<string, JidState>();

function getState(jid: string): JidState {
  let s = jidStates.get(jid);
  if (!s) {
    s = { mode: 'single', pendingZips: [], pendingCaptions: [], readyJobs: [] };
    jidStates.set(jid, s);
  }
  return s;
}

// ── Pairing buffer (dual FIFO queues) ─────────────────────────────────────────

function scheduleExpiry<T>(jid: string, queue: Array<TimedItem<T>>, item: TimedItem<T>): void {
  item.timer = setTimeout(() => {
    const idx = queue.indexOf(item);
    if (idx !== -1) queue.splice(idx, 1);
    sendText(jid, '⏱ Timed out waiting for the other half. Send the zip and caption again.').catch(() => undefined);
  }, config.PAIRING_TIMEOUT_MS);
}

/**
 * Store a zip message. If there's a pending caption, pair them and return the caption.
 * Otherwise queue the zip and return null.
 */
function storeZip(jid: string, msg: WAMessage): string | null {
  const s = getState(jid);
  if (s.pendingCaptions.length > 0) {
    const captionItem = s.pendingCaptions.shift()!;
    clearTimeout(captionItem.timer);
    return captionItem.value;
  }
  const item: TimedItem<WAMessage> = { value: msg, timer: null as any };
  scheduleExpiry(jid, s.pendingZips, item);
  s.pendingZips.push(item);
  return null;
}

/**
 * Store a caption. If there's a pending zip, pair them and return the zip WAMessage.
 * Otherwise queue the caption and return null.
 */
function storeCaption(jid: string, captionText: string): WAMessage | null {
  const s = getState(jid);
  if (s.pendingZips.length > 0) {
    const zipItem = s.pendingZips.shift()!;
    clearTimeout(zipItem.timer);
    return zipItem.value;
  }
  const item: TimedItem<string> = { value: captionText, timer: null as any };
  scheduleExpiry(jid, s.pendingCaptions, item);
  s.pendingCaptions.push(item);
  return null;
}

/** Clear all pending (unpaired) halves for a JID. */
function clearPendingBuffers(jid: string): void {
  const s = getState(jid);
  for (const item of s.pendingZips) clearTimeout(item.timer);
  for (const item of s.pendingCaptions) clearTimeout(item.timer);
  s.pendingZips.length = 0;
  s.pendingCaptions.length = 0;
}

// ── Image counting (without extracting) ───────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

function countImagesInZip(zipBuffer: Buffer): number {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter(e => !e.isDirectory && !e.entryName.includes('/') && IMAGE_EXTS.has(extOf(e.name)))
    .length;
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `🤖 *Commands*

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
4. Send /ok to process, or /cancel to abort`;

// ── Command handling ──────────────────────────────────────────────────────────

async function handleCommand(jid: string, command: string): Promise<void> {
  const s = getState(jid);
  const cmd = command.toLowerCase().trim();

  switch (cmd) {
    case '/help':
      await sendText(jid, HELP_TEXT);
      return;

    case '/batch':
      if (s.mode === 'processing') {
        await sendText(jid, '⏳ Currently processing. Wait for it to finish.');
        return;
      }
      if (s.mode === 'batch-confirming') {
        await sendText(jid, '⚠️ You have a pending /go preview. Send /ok or /cancel first.');
        return;
      }
      s.mode = 'batch-idle';
      await sendText(jid, '📦 Batch mode on. Send your zip + caption pairs, then /go when ready.');
      return;

    case '/single':
      if (s.mode === 'processing') {
        await sendText(jid, '⏳ Currently processing. Wait for it to finish.');
        return;
      }
      if (s.mode === 'batch-confirming') {
        await sendText(jid, '⚠️ You have a pending /go preview. Send /ok or /cancel first.');
        return;
      }
      s.mode = 'single';
      clearPendingBuffers(jid);
      s.readyJobs.length = 0;
      await sendText(jid, '🔁 Single mode on. Each pair will be processed immediately.');
      return;

    case '/go':
      if (s.mode === 'processing') {
        await sendText(jid, '⏳ Already processing.');
        return;
      }
      if (s.mode !== 'batch-idle') {
        await sendText(jid, '⚠️ /go only works in batch mode. Send /batch first.');
        return;
      }
      if (s.readyJobs.length === 0) {
        await sendText(jid, '⚠️ No pairs queued yet. Send some zip + caption pairs first.');
        return;
      }
      s.mode = 'batch-confirming';
      {
        const lines = s.readyJobs.map((job, i) =>
          `${i + 1}. *${job.previewTitle}*\n   📎 ${job.zipFileName} · ${job.imageCount} image${job.imageCount !== 1 ? 's' : ''}`,
        );
        await sendText(
          jid,
          `📋 *${s.readyJobs.length} pair${s.readyJobs.length !== 1 ? 's' : ''} queued:*\n\n${lines.join('\n\n')}\n\nSend /ok to process, or /cancel to abort.`,
        );
      }
      return;

    case '/ok':
      if (s.mode !== 'batch-confirming') {
        await sendText(jid, '⚠️ Nothing to confirm. Use /go first to preview your batch.');
        return;
      }
      await processBatch(jid);
      return;

    case '/cancel':
      if (s.mode === 'processing') {
        await sendText(jid, "⏳ Can't cancel while processing. Wait for it to finish.");
        return;
      }
      clearPendingBuffers(jid);
      s.readyJobs.length = 0;
      s.mode = s.mode === 'single' ? 'single' : 'batch-idle';
      await sendText(jid, '🗑 Cleared. All queued pairs and pending halves have been dropped.');
      return;

    default:
      break;
  }
}

// ── Batch processing ──────────────────────────────────────────────────────────

async function processBatch(jid: string): Promise<void> {
  const s = getState(jid);
  const jobs = [...s.readyJobs];
  s.readyJobs.length = 0;
  s.mode = 'processing';

  await sendText(jid, `⏳ Processing ${jobs.length} pair${jobs.length !== 1 ? 's' : ''}...`);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const label = `[${i + 1}/${jobs.length}] ${job.previewTitle}`;
    logger.info(`Batch ${label}: starting`);

    const msgId = job.zipMsg.key.id!;
    const result = await runPipeline({ msgId, zipBuffer: job.zipBuffer, captionText: job.captionText });

    if (result.ok) {
      await sendText(jid, `✅ ${label}\n${result.docName}\n\n${result.url}\n\n📁 ${result.folderUrl}`);
    } else {
      await sendText(jid, `❌ ${label}\n${result.userMessage}`);
    }
  }

  s.mode = 'batch-idle';
  await sendText(jid, `✅ Batch complete. ${jobs.length} pair${jobs.length !== 1 ? 's' : ''} processed.`);
}

// ── Pair completion handler ───────────────────────────────────────────────────

async function onPairCompleted(jid: string, zipMsg: WAMessage, captionText: string): Promise<void> {
  const s = getState(jid);

  // Download the zip (needed now for both modes — single processes immediately,
  // batch needs the buffer for image count preview)
  let zipBuffer: Buffer;
  try {
    zipBuffer = (await downloadMediaMessage(zipMsg, 'buffer', {})) as Buffer;
  } catch (err) {
    logger.error('Failed to download zip:', err);
    await sendText(jid, '❌ Failed to download the zip. Try sending it again.');
    return;
  }

  const { title } = parseCaption(captionText);
  const zipFileName = zipMsg.message?.documentMessage?.fileName ?? 'unknown.zip';
  const imageCount = countImagesInZip(zipBuffer);

  if (s.mode === 'single') {
    // Process immediately (existing behaviour)
    await sendText(jid, '⏳ Got both. Building the doc...');
    const msgId = zipMsg.key.id!;
    logger.info(`Processing carousel for ${jid} (msg ${msgId})`);
    const result = await runPipeline({ msgId, zipBuffer, captionText });
    await sendText(jid, result.ok ? `✅ ${result.docName}\n\n${result.url}\n\n📁 Campaign folder: ${result.folderUrl}` : result.userMessage);
  } else {
    // Batch mode — enqueue
    s.readyJobs.push({
      zipMsg,
      zipBuffer,
      captionText,
      previewTitle: title || '(untitled)',
      zipFileName,
      imageCount,
    });
    await sendText(jid, `📦 Pair queued (#${s.readyJobs.length}): *${title || '(untitled)'}* — ${imageCount} image${imageCount !== 1 ? 's' : ''}`);
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  const { state, saveCreds } = useSqliteAuthState(config.BAILEYS_DB_PATH);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Connecting with WA v${version.join('.')} (isLatest: ${isLatest})`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    logger: require('pino')({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingCodeRequested && !state.creds.registered) {
      pairingCodeRequested = true;
      const phoneNumber = config.ALLOWED_JIDS[0].replace(/[^0-9]/g, '');
      try {
        const code = await sock!.requestPairingCode(phoneNumber);
        logger.info(`\n\n  WhatsApp pairing code: ${code}\n\n  Open WhatsApp → Linked Devices → Link with phone number\n`);
      } catch (err) {
        logger.warn('Pairing code request failed:', err);
      }
    }

    if (connection === 'open') logger.info('WhatsApp connected ✓');

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`Connection closed (${statusCode}). Reconnecting: ${reconnect}`);
      if (reconnect) setTimeout(connect, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid!;

      logger.info(`Incoming LID: ${jid}`);
      if (!config.ALLOWED_JIDS.includes(jid)) continue;

      const s = getState(jid);
      const content = msg.message;
      const docMsg = content.documentMessage;
      const textMsg = content.conversation || content.extendedTextMessage?.text || '';

      const isZip =
        docMsg &&
        (docMsg.fileName?.endsWith('.zip') ||
          docMsg.mimetype === 'application/zip' ||
          docMsg.mimetype === 'application/x-zip-compressed');

      // ── Command handling ──────────────────────────────────────────────────
      if (!isZip && textMsg && textMsg.startsWith('/')) {
        // In batch-confirming state, only /ok, /cancel, and /help are valid
        if (s.mode === 'batch-confirming' && !['/ok', '/cancel', '/help'].includes(textMsg.toLowerCase().trim())) {
          await sendText(jid, '⚠️ Awaiting confirmation. Send /ok to proceed or /cancel to abort.');
          continue;
        }
        await handleCommand(jid, textMsg);
        continue;
      }

      // ── Block content during confirming or processing ─────────────────────
      if (s.mode === 'batch-confirming') {
        await sendText(jid, '⚠️ Awaiting confirmation. Send /ok to proceed or /cancel to abort.');
        continue;
      }
      if (s.mode === 'processing') {
        await sendText(jid, '⏳ Currently processing a batch. Please wait.');
        continue;
      }

      // ── Zip / caption pairing ─────────────────────────────────────────────
      if (isZip) {
        const caption = docMsg.caption?.trim() ?? '';

        if (caption) {
          logger.info(`zip+caption from ${jid}`);
          await onPairCompleted(jid, msg, caption);
        } else {
          const pairedCaption = storeZip(jid, msg);
          if (pairedCaption != null) {
            await onPairCompleted(jid, msg, pairedCaption);
          } else {
            await sendText(jid, '📦 Got the zip. Send the caption next.');
          }
        }
      } else if (textMsg) {
        const pairedZipMsg = storeCaption(jid, textMsg);
        if (pairedZipMsg != null) {
          await onPairCompleted(jid, pairedZipMsg, textMsg);
        } else {
          await sendText(jid, '📝 Got the caption. Send the zip next.');
        }
      }
    }
  });
}

export { connect };
