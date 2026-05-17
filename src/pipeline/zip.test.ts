/**
 * Unit tests for src/pipeline/zip.ts
 *
 * Strategy: build real in-memory zips with AdmZip and write them to a
 * tmp directory so extractAndValidateZip gets an actual file path.
 * No mocking of AdmZip internals — tests stay close to real behaviour.
 */

import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractAndValidateZip, ZipValidationError, ExtractedImages } from './zip';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 1×1 transparent PNG — smallest valid PNG bytes */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
  'hex',
);

function makeZip(files: Record<string, Buffer | null>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, content ?? TINY_PNG);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  const zipPath = path.join(tmp, 'test.zip');
  zip.writeZip(zipPath);
  return zipPath;
}

function isError(r: ExtractedImages | ZipValidationError): r is ZipValidationError {
  return 'kind' in r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractAndValidateZip', () => {
  let destDir: string;

  beforeEach(() => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-dest-'));
  });

  afterEach(() => {
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  // ── Happy paths ──────────────────────────────────────────────────────────

  describe('valid zips — bare number naming (old style)', () => {
    it('accepts 1.png', () => {
      const zipPath = makeZip({ '1.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      const { files } = result as ExtractedImages;
      expect(files).toHaveLength(1);
      expect(path.basename(files[0])).toBe('1.png');
    });

    it('accepts 1.jpg, 2.jpg, 3.jpg in any zip order', () => {
      const zipPath = makeZip({ '3.jpg': null, '1.jpg': null, '2.jpg': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      const { files } = result as ExtractedImages;
      expect(files.map(f => path.basename(f))).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    });

    it('accepts zero-padded numbers (01.jpeg)', () => {
      const zipPath = makeZip({ '01.jpeg': null, '02.jpeg': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      const { files } = result as ExtractedImages;
      expect(files).toHaveLength(2);
    });

    it('accepts a full set of 10 images', () => {
      const files: Record<string, null> = {};
      for (let i = 1; i <= 10; i++) files[`${i}.png`] = null;
      const zipPath = makeZip(files);
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      expect((result as ExtractedImages).files).toHaveLength(10);
    });
  });

  describe('valid zips — parenthesised prefix naming (new style)', () => {
    it('accepts "dives (1).png"', () => {
      const zipPath = makeZip({ 'dives (1).png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      const { files } = result as ExtractedImages;
      expect(files).toHaveLength(1);
    });

    it('accepts "balloons pop (1).jpg", "balloons pop (2).jpg"', () => {
      const zipPath = makeZip({
        'balloons pop (2).jpg': null,
        'balloons pop (1).jpg': null,
      });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      const { files } = result as ExtractedImages;
      // sorted by number, not alpha
      expect(files.map(f => path.basename(f))).toEqual([
        'balloons pop (1).jpg',
        'balloons pop (2).jpg',
      ]);
    });

    it('accepts mixed prefix styles in the same zip', () => {
      const zipPath = makeZip({ '1.png': null, 'slide (2).png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      expect((result as ExtractedImages).files).toHaveLength(2);
    });

    it('accepts multi-word prefix with numbers in the prefix ("trip 2024 (1).jpg")', () => {
      const zipPath = makeZip({ 'trip 2024 (1).jpg': null, 'trip 2024 (2).jpg': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      expect((result as ExtractedImages).files).toHaveLength(2);
    });
  });

  // ── Error paths ──────────────────────────────────────────────────────────

  describe('empty', () => {
    it('returns empty when zip has no image files', () => {
      const zipPath = makeZip({ 'readme.txt': Buffer.from('hello') });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('empty');
    });

    it('returns empty when zip has only macOS junk', () => {
      const zipPath = makeZip({
        '__MACOSX/._1.png': TINY_PNG,
        '.DS_Store': Buffer.from('junk'),
      });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('empty');
    });
  });

  describe('too_many', () => {
    it('returns too_many for 11 images', () => {
      const files: Record<string, null> = {};
      for (let i = 1; i <= 11; i++) files[`${i}.png`] = null;
      const zipPath = makeZip(files);
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('too_many');
    });
  });

  describe('wrong_naming', () => {
    it('rejects a file with no number at all ("cover.png")', () => {
      const zipPath = makeZip({ 'cover.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('wrong_naming');
    });

    it('rejects a file with number but wrong format ("slide-1.png")', () => {
      const zipPath = makeZip({ 'slide-1.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('wrong_naming');
    });
  });

  describe('missing_numbers', () => {
    it('rejects a gap in sequence (1, 3 — missing 2)', () => {
      const zipPath = makeZip({ '1.png': null, '3.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('missing_numbers');
    });

    it('rejects sequence not starting at 1 (2, 3)', () => {
      const zipPath = makeZip({ '2.png': null, '3.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('missing_numbers');
    });

    it('rejects gap with parenthesised names ("dives (1).png", "dives (3).png")', () => {
      const zipPath = makeZip({ 'dives (1).png': null, 'dives (3).png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(true);
      expect((result as ZipValidationError).kind).toBe('missing_numbers');
    });
  });

  // ── Extraction ───────────────────────────────────────────────────────────

  describe('extraction', () => {
    it('creates destDir if it does not exist', () => {
      const nonExistent = path.join(destDir, 'subdir');
      const zipPath = makeZip({ '1.png': null });
      extractAndValidateZip(zipPath, nonExistent);
      expect(fs.existsSync(nonExistent)).toBe(true);
    });

    it('returns absolute paths that exist on disk', () => {
      const zipPath = makeZip({ '1.png': null, '2.png': null });
      const result = extractAndValidateZip(zipPath, destDir);
      expect(isError(result)).toBe(false);
      for (const f of (result as ExtractedImages).files) {
        expect(path.isAbsolute(f)).toBe(true);
        expect(fs.existsSync(f)).toBe(true);
      }
    });
  });
});
