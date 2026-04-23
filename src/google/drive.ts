import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import { getOAuth2Client } from './auth';
import { config } from '../config';

function getDrive() {
  return google.drive({ version: 'v3', auth: getOAuth2Client() });
}

export async function copyTemplate(templateId: string, title: string): Promise<string> {
  const drive = getDrive();
  const truncated = title.slice(0, 80);
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const name = `Approval - ${truncated} - ${now}`;

  const res = await drive.files.copy({
    fileId: templateId,
    requestBody: {
      name,
      parents: [config.OUTPUT_FOLDER_ID],
    },
  });

  return res.data.id!;
}

export async function uploadImage(filePath: string): Promise<{ driveFileId: string; publicUrl: string }> {
  const drive = getDrive();
  const name = path.basename(filePath);
  const mimeType = filePath.match(/\.png$/i) ? 'image/png' : 'image/jpeg';

  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [config.TEMP_IMAGE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id',
  });

  const driveFileId = res.data.id!;

  await drive.permissions.create({
    fileId: driveFileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    driveFileId,
    publicUrl: `https://drive.google.com/uc?id=${driveFileId}`,
  };
}

export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDrive();
  await drive.files.delete({ fileId });
}

export async function shareDoc(docId: string): Promise<void> {
  const drive = getDrive();
  await drive.permissions.create({
    fileId: docId,
    requestBody: { role: config.OUTPUT_DOC_PERMISSION, type: 'anyone' },
  });
}
