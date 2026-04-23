import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCaption } from './parseText';
import { extractAndValidateZip } from './zip';
import { cleanupLocalDir } from './cleanup';
import { createFolder, copyTemplate, uploadImage, shareDoc, renameFile } from '../google/drive';
import { fillDoc } from '../google/docs';
import { config } from '../config';
import { logger } from '../logger';

export interface PipelineInput {
  msgId: string;
  zipBuffer: Buffer;
  captionText: string;
}

export interface PipelineResult {
  ok: true;
  url: string;
}

export interface PipelineError {
  ok: false;
  userMessage: string;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult | PipelineError> {
  const tempDir = path.join(os.tmpdir(), `carousel-${input.msgId}`);

  try {
    // ── Parse text ──────────────────────────────────────────────────────────
    const { title, captionBody, hashtags } = parseCaption(input.captionText);

    if (!title) {
      return { ok: false, userMessage: '⚠️ The caption needs a title on the first line.' };
    }

    // ── Extract zip ──────────────────────────────────────────────────────────
    const zipPath = path.join(tempDir, 'upload.zip');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(zipPath, input.zipBuffer);

    const extractDir = path.join(tempDir, 'images');
    const extracted = extractAndValidateZip(zipPath, extractDir);

    if ('kind' in extracted) {
      switch (extracted.kind) {
        case 'empty':
          return { ok: false, userMessage: '⚠️ The zip is empty.' };
        case 'too_many':
          return { ok: false, userMessage: '⚠️ Max 10 images per carousel.' };
        case 'non_image_files':
          return { ok: false, userMessage: '⚠️ The zip has non-image files. Images only (JPG/PNG).' };
        case 'wrong_naming':
        case 'missing_numbers':
          return { ok: false, userMessage: '⚠️ Images should be named 1.jpg, 2.jpg, etc.' };
      }
    }

    const { files: imageFiles } = extracted;

    // ── Create campaign folder ──────────────────────────────────────────────
    const campaignFolderId = await createFolder(config.OUTPUT_FOLDER_ID, title);

    // ── Upload images to Drive ──────────────────────────────────────────────
    const imageSlots: Array<{ driveFileId: string; publicUrl: string }> = [];

    for (const filePath of imageFiles) {
      const slot = await uploadImage(filePath, campaignFolderId);
      imageSlots.push(slot);
    }

    // ── Select template and copy ────────────────────────────────────────────
    const usesFb = captionBody.includes(config.TRIGGER_URL);
    const templateId = usesFb ? config.TEMPLATE_ID_IG_FB : config.TEMPLATE_ID_IG;
    const docId = await copyTemplate(templateId, title, campaignFolderId);

    // ── Fill document ───────────────────────────────────────────────────────
    try {
      await fillDoc(docId, title, captionBody, hashtags, imageSlots);
    } catch (err) {
      logger.error('fillDoc failed:', err);
      return { ok: false, userMessage: "❌ Couldn't build the doc. I logged it — check the VPS." };
    }

    // ── Rename document ─────────────────────────────────────────────────────
    const docName = `[APPROVAL | GRAPHICS] ${title}`;
    await renameFile(docId, docName);

    // ── Share ───────────────────────────────────────────────────────────────
    await shareDoc(docId);
    const url = `https://docs.google.com/document/d/${docId}/edit`;

    return { ok: true, url };
  } catch (err) {
    logger.error('Pipeline error:', err);
    return { ok: false, userMessage: '❌ Something broke. Check the logs.' };
  } finally {
    cleanupLocalDir(tempDir);
  }
}
