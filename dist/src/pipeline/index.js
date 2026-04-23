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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPipeline = runPipeline;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const parseText_1 = require("./parseText");
const zip_1 = require("./zip");
const cleanup_1 = require("./cleanup");
const drive_1 = require("../google/drive");
const docs_1 = require("../google/docs");
const config_1 = require("../config");
const logger_1 = require("../logger");
async function runPipeline(input) {
    const tempDir = path.join(os.tmpdir(), `carousel-${input.msgId}`);
    try {
        // ── Parse text ──────────────────────────────────────────────────────────
        const { title, captionBody, hashtags } = (0, parseText_1.parseCaption)(input.captionText);
        if (!title) {
            return { ok: false, userMessage: '⚠️ The caption needs a title on the first line.' };
        }
        // ── Extract zip ──────────────────────────────────────────────────────────
        const zipPath = path.join(tempDir, 'upload.zip');
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(zipPath, input.zipBuffer);
        const extractDir = path.join(tempDir, 'images');
        const extracted = (0, zip_1.extractAndValidateZip)(zipPath, extractDir);
        if ('kind' in extracted) {
            switch (extracted.kind) {
                case 'empty':
                    return { ok: false, userMessage: '⚠️ The zip is empty.' };
                case 'too_many':
                    return { ok: false, userMessage: '⚠️ Max 10 images per carousel.' };
                case 'wrong_naming':
                case 'missing_numbers':
                    return { ok: false, userMessage: '⚠️ Images should be named 1.jpg, 2.jpg, etc.' };
            }
        }
        const { files: imageFiles } = extracted;
        // ── Create campaign folder ──────────────────────────────────────────────
        const campaignFolderId = await (0, drive_1.createFolder)(config_1.config.OUTPUT_FOLDER_ID, title);
        // ── Upload images to Drive ──────────────────────────────────────────────
        const imageSlots = await Promise.all(imageFiles.map(filePath => (0, drive_1.uploadImage)(filePath, campaignFolderId)));
        // ── Select template and copy ────────────────────────────────────────────
        const igOnly = captionBody.includes(config_1.config.TRIGGER_URL);
        const templateId = igOnly ? config_1.config.TEMPLATE_ID_IG : config_1.config.TEMPLATE_ID_IG_FB;
        const docId = await (0, drive_1.copyTemplate)(templateId, title, campaignFolderId);
        // ── Fill document ───────────────────────────────────────────────────────
        try {
            await (0, docs_1.fillDoc)(docId, title, captionBody, hashtags, imageSlots);
        }
        catch (err) {
            logger_1.logger.error('fillDoc failed:', err);
            return { ok: false, userMessage: "❌ Couldn't build the doc. I logged it — check the VPS." };
        }
        // ── Rename document ─────────────────────────────────────────────────────
        const docName = `[APPROVAL | GRAPHICS] ${title}`;
        await (0, drive_1.renameFile)(docId, docName);
        // ── Share ───────────────────────────────────────────────────────────────
        await (0, drive_1.shareDoc)(docId);
        const url = `https://docs.google.com/document/d/${docId}/edit`;
        const folderUrl = `https://drive.google.com/drive/folders/${campaignFolderId}`;
        return { ok: true, url, folderUrl, docName };
    }
    catch (err) {
        logger_1.logger.error('Pipeline error:', err);
        return { ok: false, userMessage: '❌ Something broke. Check the logs.' };
    }
    finally {
        (0, cleanup_1.cleanupLocalDir)(tempDir);
    }
}
//# sourceMappingURL=index.js.map