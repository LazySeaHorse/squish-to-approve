"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connect = connect;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const sqliteAuthState_1 = require("./sqliteAuthState");
const pipeline_1 = require("../pipeline");
const parseText_1 = require("../pipeline/parseText");
const config_1 = require("../config");
const logger_1 = require("../logger");
/** Directory for spooling zip files to disk while a batch is being built. */
const BATCH_SPOOL_DIR = path.join('data', 'batch-spool');
let sock = null;
async function sendText(jid, text) {
    if (!sock)
        return;
    try {
        await sock.sendMessage(jid, { text });
    }
    catch (err) {
        logger_1.logger.error('Failed to send message:', err);
    }
}
const jidStates = new Map();
function getState(jid) {
    let s = jidStates.get(jid);
    if (!s) {
        s = { mode: 'single', pendingZips: [], pendingCaptions: [], readyJobs: [] };
        jidStates.set(jid, s);
    }
    return s;
}
// ── Pairing buffer (dual FIFO queues) ─────────────────────────────────────────
function scheduleExpiry(jid, queue, item) {
    item.timer = setTimeout(() => {
        const idx = queue.indexOf(item);
        if (idx !== -1)
            queue.splice(idx, 1);
        sendText(jid, '⏱ Timed out waiting for the other half. Send the zip and caption again.').catch(() => undefined);
    }, config_1.config.PAIRING_TIMEOUT_MS);
}
/**
 * Store a zip message. If there's a pending caption, pair them and return the caption.
 * Otherwise queue the zip and return null.
 */
function storeZip(jid, msg) {
    const s = getState(jid);
    if (s.pendingCaptions.length > 0) {
        const captionItem = s.pendingCaptions.shift();
        clearTimeout(captionItem.timer);
        return captionItem.value;
    }
    const item = { value: msg, timer: null };
    scheduleExpiry(jid, s.pendingZips, item);
    s.pendingZips.push(item);
    return null;
}
/**
 * Store a caption. If there's a pending zip, pair them and return the zip WAMessage.
 * Otherwise queue the caption and return null.
 */
function storeCaption(jid, captionText) {
    const s = getState(jid);
    if (s.pendingZips.length > 0) {
        const zipItem = s.pendingZips.shift();
        clearTimeout(zipItem.timer);
        return zipItem.value;
    }
    const item = { value: captionText, timer: null };
    scheduleExpiry(jid, s.pendingCaptions, item);
    s.pendingCaptions.push(item);
    return null;
}
/** Clear all pending (unpaired) halves for a JID. */
function clearPendingBuffers(jid) {
    const s = getState(jid);
    for (const item of s.pendingZips)
        clearTimeout(item.timer);
    for (const item of s.pendingCaptions)
        clearTimeout(item.timer);
    s.pendingZips.length = 0;
    s.pendingCaptions.length = 0;
}
/** Delete all spooled zip files for jobs in the given array. */
function cleanupSpooledZips(jobs) {
    for (const job of jobs) {
        try {
            fs.unlinkSync(job.zipPath);
        }
        catch {
            // Already deleted or never written — fine.
        }
    }
}
// ── Image counting (without extracting) ───────────────────────────────────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
function countImagesInZip(zipBuffer) {
    const zip = new adm_zip_1.default(zipBuffer);
    return zip
        .getEntries()
        .filter(e => !e.isDirectory && !e.entryName.includes('/') && IMAGE_EXTS.has(extOf(e.name)))
        .length;
}
function extOf(filename) {
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
async function handleCommand(jid, command) {
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
                const lines = s.readyJobs.map((job, i) => `${i + 1}. *${job.previewTitle}*\n   📎 ${job.zipFileName} · ${job.imageCount} image${job.imageCount !== 1 ? 's' : ''}`);
                await sendText(jid, `📋 *${s.readyJobs.length} pair${s.readyJobs.length !== 1 ? 's' : ''} queued:*\n\n${lines.join('\n\n')}\n\nSend /ok to process, or /cancel to abort.`);
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
            cleanupSpooledZips(s.readyJobs);
            s.readyJobs.length = 0;
            s.mode = s.mode === 'single' ? 'single' : 'batch-idle';
            await sendText(jid, '🗑 Cleared. All queued pairs and pending halves have been dropped.');
            return;
        default:
            break;
    }
}
// ── Batch processing ──────────────────────────────────────────────────────────
async function processBatch(jid) {
    const s = getState(jid);
    const jobs = [...s.readyJobs];
    s.readyJobs.length = 0;
    s.mode = 'processing';
    await sendText(jid, `⏳ Processing ${jobs.length} pair${jobs.length !== 1 ? 's' : ''}...`);
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const label = `[${i + 1}/${jobs.length}] ${job.previewTitle}`;
        logger_1.logger.info(`Batch ${label}: starting`);
        // Read the zip from disk — only one buffer in memory at a time
        let zipBuffer;
        try {
            zipBuffer = fs.readFileSync(job.zipPath);
        }
        catch (err) {
            logger_1.logger.error(`Failed to read spooled zip ${job.zipPath}:`, err);
            await sendText(jid, `❌ ${label}\nFailed to read the zip from disk.`);
            continue;
        }
        const msgId = job.zipMsg.key.id;
        const result = await (0, pipeline_1.runPipeline)({ msgId, zipBuffer, captionText: job.captionText });
        if (result.ok) {
            await sendText(jid, `✅ ${label}\n${result.docName}\n\n${result.url}\n\n📁 ${result.folderUrl}`);
        }
        else {
            await sendText(jid, `❌ ${label}\n${result.userMessage}`);
        }
    }
    // Clean up all spooled zip files
    cleanupSpooledZips(jobs);
    s.mode = 'batch-idle';
    await sendText(jid, `✅ Batch complete. ${jobs.length} pair${jobs.length !== 1 ? 's' : ''} processed.`);
}
// ── Pair completion handler ───────────────────────────────────────────────────
async function onPairCompleted(jid, zipMsg, captionText) {
    const s = getState(jid);
    // Download the zip (needed now for both modes — single processes immediately,
    // batch needs the buffer for image count preview)
    let zipBuffer;
    try {
        zipBuffer = (await (0, baileys_1.downloadMediaMessage)(zipMsg, 'buffer', {}));
    }
    catch (err) {
        logger_1.logger.error('Failed to download zip:', err);
        await sendText(jid, '❌ Failed to download the zip. Try sending it again.');
        return;
    }
    const { title } = (0, parseText_1.parseCaption)(captionText);
    const zipFileName = zipMsg.message?.documentMessage?.fileName ?? 'unknown.zip';
    let imageCount;
    try {
        imageCount = countImagesInZip(zipBuffer);
    }
    catch (err) {
        logger_1.logger.error('Failed to read zip (corrupt?):', err);
        await sendText(jid, '❌ That zip file appears to be corrupt. Try re-zipping and sending again.');
        return;
    }
    if (s.mode === 'single') {
        // Process immediately (existing behaviour)
        await sendText(jid, '⏳ Got both. Building the doc...');
        const msgId = zipMsg.key.id;
        logger_1.logger.info(`Processing carousel for ${jid} (msg ${msgId})`);
        const result = await (0, pipeline_1.runPipeline)({ msgId, zipBuffer, captionText });
        await sendText(jid, result.ok ? `✅ ${result.docName}\n\n${result.url}\n\n📁 Campaign folder: ${result.folderUrl}` : result.userMessage);
    }
    else {
        // Batch mode — spool zip to disk so we don't hold all buffers in RAM
        fs.mkdirSync(BATCH_SPOOL_DIR, { recursive: true });
        const spoolPath = path.join(BATCH_SPOOL_DIR, `${zipMsg.key.id}.zip`);
        fs.writeFileSync(spoolPath, zipBuffer);
        s.readyJobs.push({
            zipMsg,
            zipPath: spoolPath,
            captionText,
            previewTitle: title || '(untitled)',
            zipFileName,
            imageCount,
        });
        await sendText(jid, `📦 Pair queued (#${s.readyJobs.length}): *${title || '(untitled)'}* — ${imageCount} image${imageCount !== 1 ? 's' : ''}`);
    }
}
// ── Connect ───────────────────────────────────────────────────────────────────
async function connect() {
    const { state, saveCreds } = (0, sqliteAuthState_1.useSqliteAuthState)(config_1.config.BAILEYS_DB_PATH);
    const { version, isLatest } = await (0, baileys_1.fetchLatestBaileysVersion)();
    logger_1.logger.info(`Connecting with WA v${version.join('.')} (isLatest: ${isLatest})`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sock = (0, baileys_1.default)({
        version,
        auth: state,
        browser: baileys_1.Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        logger: require('pino')({ level: 'silent' }),
    });
    sock.ev.on('creds.update', saveCreds);
    let pairingCodeRequested = false;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !pairingCodeRequested && !state.creds.registered) {
            pairingCodeRequested = true;
            const phoneNumber = config_1.config.ALLOWED_JIDS[0].replace(/[^0-9]/g, '');
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                logger_1.logger.info(`\n\n  WhatsApp pairing code: ${code}\n\n  Open WhatsApp → Linked Devices → Link with phone number\n`);
            }
            catch (err) {
                logger_1.logger.warn('Pairing code request failed:', err);
            }
        }
        if (connection === 'open')
            logger_1.logger.info('WhatsApp connected ✓');
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
            logger_1.logger.warn(`Connection closed (${statusCode}). Reconnecting: ${reconnect}`);
            if (reconnect)
                setTimeout(connect, 3000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify')
            return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe)
                continue;
            const jid = msg.key.remoteJid;
            logger_1.logger.info(`Incoming LID: ${jid}`);
            if (!config_1.config.ALLOWED_JIDS.includes(jid))
                continue;
            const s = getState(jid);
            const content = msg.message;
            const docMsg = content.documentMessage;
            const textMsg = content.conversation || content.extendedTextMessage?.text || '';
            const isZip = docMsg &&
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
                    logger_1.logger.info(`zip+caption from ${jid}`);
                    await onPairCompleted(jid, msg, caption);
                }
                else {
                    const pairedCaption = storeZip(jid, msg);
                    if (pairedCaption != null) {
                        await onPairCompleted(jid, msg, pairedCaption);
                    }
                    else {
                        await sendText(jid, '📦 Got the zip. Send the caption next.');
                    }
                }
            }
            else if (textMsg) {
                const pairedZipMsg = storeCaption(jid, textMsg);
                if (pairedZipMsg != null) {
                    await onPairCompleted(jid, pairedZipMsg, textMsg);
                }
                else {
                    await sendText(jid, '📝 Got the caption. Send the zip next.');
                }
            }
        }
    });
}
//# sourceMappingURL=client.js.map