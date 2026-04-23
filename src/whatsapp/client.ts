import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
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
interface Pending {
  zipMsg?: WAMessage;
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
          logger.info(`zip+caption from ${jid}`);
          processZipMsg(jid, msg, caption);
        } else {
          const pairedCaption = storeZip(jid, msg);
          if (pairedCaption != null) {
            processZipMsg(jid, msg, pairedCaption);
          } else {
            await sendText(jid, '📦 Got the zip. Send the caption next.');
          }
        }
      } else if (textMsg) {
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
  await sendText(jid, result.ok ? `✅ Approval doc ready: ${result.url}\n\n📁 Campaign folder: ${result.folderUrl}` : result.userMessage);
}

export { connect };
