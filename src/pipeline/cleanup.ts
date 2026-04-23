import * as fs from 'fs';
import { deleteFile } from '../google/drive';
import { logger } from '../logger';

export async function cleanupDriveFiles(fileIds: string[]): Promise<void> {
  await Promise.allSettled(
    fileIds.map(id =>
      deleteFile(id).catch(err => logger.warn(`Failed to delete Drive file ${id}:`, err)),
    ),
  );
}

export function cleanupLocalDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`Failed to clean up local dir ${dir}:`, err);
  }
}
