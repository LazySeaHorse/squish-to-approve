import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const MAX_IMAGES = 10;

export interface ZipValidationError {
  kind: 'wrong_naming' | 'too_many' | 'empty' | 'missing_numbers';
  message: string;
}

export interface ExtractedImages {
  files: string[]; // absolute paths, sorted by slide number
}

export function extractAndValidateZip(
  zipPath: string,
  destDir: string,
): ExtractedImages | ZipValidationError {
  const zip = new AdmZip(zipPath);
  const entries = zip
    .getEntries()
    .filter(e => !e.isDirectory && !e.entryName.includes('/') && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()));

  if (entries.length === 0) {
    return { kind: 'empty', message: 'The zip is empty.' };
  }

  if (entries.length > MAX_IMAGES) {
    return { kind: 'too_many', message: `${entries.length} images found; max is ${MAX_IMAGES}.` };
  }

  // Validate naming: must match /^\d+\.(jpg|jpeg|png)$/i
  const nameRe = /^0*(\d+)\.(jpg|jpeg|png)$/i;
  const numbered: Array<{ n: number; name: string }> = [];

  for (const entry of entries) {
    const m = entry.name.match(nameRe);
    if (!m) {
      return {
        kind: 'wrong_naming',
        message: `"${entry.name}" doesn't match the expected naming (1.jpg, 2.png, ...).`,
      };
    }
    numbered.push({ n: parseInt(m[1], 10), name: entry.name });
  }

  // Must have consecutive numbers 1..N
  numbered.sort((a, b) => a.n - b.n);
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i].n !== i + 1) {
      return {
        kind: 'missing_numbers',
        message: `Expected slide ${i + 1} but found slide ${numbered[i].n}.`,
      };
    }
  }

  // Extract
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);

  const files = numbered.map(({ name }) => path.join(destDir, name));
  return { files };
}
