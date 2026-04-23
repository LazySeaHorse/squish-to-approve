import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { useSqliteAuthState } from './sqliteAuthState';
import { runPipeline } from '../pipeline';
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

// ── Pairing buffer ────────────────────────────────────────────────────────────
// Holds a partial zip+caption pair while waiting for the other half.
interface Pending {
  zipMsg?: WAMessage;  // the raw Baileys message (for download at pair-time)
  captionText?: string;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

function scheduleExpiry(jid: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    pending.delete(jid);
    sendText(jid, '⏱ Timed out. Send the zip and caption again.').catch(() => undefined);
  }, config.PAIRING_TIMEOUT_MS);
}

function storeZip(jid: string, msg: WAMessage): string | null {
  const entry = pending.get(jid);
  if (entry?.captionText != null) {
    // Caption already waiting — pair now
    clearTimeout(entry.timer);
    pending.delete(jid);
    return entry.captionText;
  }
  if (entry) clearTimeout(entry.timer);
  pending.set(jid, { zipMsg: msg, timer: scheduleExpiry(jid) });
  return null;
}

function storeCaption(jid: string, captionText: string): WAMessage | null {
  const entry = pending.get(jid);
  if (entry?.zipMsg != null) {
    // Zip already waiting — pair now
    clearTimeout(entry.timer);
    const zipMsg = entry.zipMsg;
    pending.delete(jid);
    return zipMsg;
  }
  if (entry) clearTimeout(entry.timer);
  pending.set(jid, { captionText, timer: scheduleExpiry(jid) });
  return null;
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function connect(): Promise<void> {
  const { state, saveCreds } = useSqliteAuthState(config.BAILEYS_DB_PATH);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sock = makeWASocket({ auth: state, logger: require('pino')({ level: 'silent' }) });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) logger.info('QR code — scan with WhatsApp:\n' + qr);

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

      if (!config.ALLOWED_JIDS.includes(jid)) continue;

      const content = msg.message;
      const docMsg = content.documentMessage;
      const textMsg = content.conversation || content.extendedTextMessage?.text || '';

      const isZip =
        docMsg &&
        (docMsg.fileName?.endsWith('.zip') ||
          docMsg.mimetype === 'application/zip' ||
          docMsg.mimetype === 'application/x-zip-compressed');

      if (isZip) {
        const caption = docMsg.caption?.trim() ?? '';

        if (caption) {
          // Zip + caption together
          logger.info(`zip+caption from ${jid}`);
          processZipMsg(jid, msg, caption);
        } else {
          // Zip only — wait for caption
          const pairedCaption = storeZip(jid, msg);
          if (pairedCaption != null) {
            processZipMsg(jid, msg, pairedCaption);
          } else {
            await sendText(jid, '📦 Got the zip. Send the caption next.');
          }
        }
      } else if (textMsg) {
        // Text only — might be caption pairing with a pending zip
        const pairedZipMsg = storeCaption(jid, textMsg);
        if (pairedZipMsg != null) {
          processZipMsg(jid, pairedZipMsg, textMsg);
        } else {
          await sendText(jid, '📝 Got the caption. Send the zip next.');
        }
      }
    }
  });
}

async function processZipMsg(jid: string, msg: WAMessage, captionText: string): Promise<void> {
  let zipBuffer: Buffer;
  try {
    zipBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
  } catch (err) {
    logger.error('Failed to download zip:', err);
    await sendText(jid, '❌ Something broke. Check the logs.');
    return;
  }

  const msgId = msg.key.id!;
  logger.info(`Processing carousel for ${jid} (msg ${msgId})`);
  const result = await runPipeline({ msgId, zipBuffer, captionText });
  await sendText(jid, result.ok ? `✅ Approval doc ready: ${result.url}` : result.userMessage);
}

export { connect };
