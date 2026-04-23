import { google, docs_v1 } from 'googleapis';
import { getOAuth2Client } from './auth';
import { logger } from '../logger';

function getDocs() {
  return google.docs({ version: 'v1', auth: getOAuth2Client() });
}

interface ImageSlot {
  driveFileId: string;
  publicUrl: string;
}

export async function fillDoc(
  docId: string,
  title: string,
  captionBody: string,
  hashtags: string[],
  images: ImageSlot[],
): Promise<void> {
  const docs = getDocs();

  // Phase A: text replacements
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: { text: '{{TITLE}}', matchCase: true },
            replaceText: title,
          },
        },
        {
          replaceAllText: {
            containsText: { text: '{{CAPTION}}', matchCase: true },
            replaceText: captionBody,
          },
        },
        {
          replaceAllText: {
            containsText: { text: '{{HASHTAGS}}', matchCase: true },
            replaceText: hashtags.join(' '),
          },
        },
      ],
    },
  });

  // Phase B: image slots — process 10 down to 1 sequentially with re-fetch each time
  // to avoid index invalidation issues
  for (let n = 10; n >= 1; n--) {
    const placeholder = `{{IMAGE_${n}}}`;
    const slot = images[n - 1]; // undefined when n > imageCount

    const docContent = await docs.documents.get({ documentId: docId });
    const body = docContent.data.body!;

    if (slot) {
      // Replace the placeholder text with an inline image
      const range = findTextRange(body, placeholder);
      if (!range) {
        logger.warn(`Placeholder ${placeholder} not found in doc — skipping`);
        continue;
      }

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              deleteContentRange: {
                range: { startIndex: range.start, endIndex: range.end },
              },
            },
            {
              insertInlineImage: {
                location: { index: range.start },
                uri: slot.publicUrl,
                // Let Docs pick dimensions; it will use the image's natural size capped by page width
                objectSize: undefined,
              },
            },
          ],
        },
      });
    } else {
      // Delete the entire block containing this placeholder
      const blockRange = findBlockRange(body, placeholder);
      if (!blockRange) {
        logger.warn(`Block for ${placeholder} not found — skipping`);
        continue;
      }

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              deleteContentRange: {
                range: { startIndex: blockRange.start, endIndex: blockRange.end },
              },
            },
          ],
        },
      });
    }
  }
}

// Finds the start/end index of a literal text string inside the doc body.
function findTextRange(
  body: docs_v1.Schema$Body,
  text: string,
): { start: number; end: number } | null {
  for (const element of body.content ?? []) {
    const result = findInParagraph(element, text);
    if (result) return result;

    // Check inside table cells
    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const cellElement of cell.content ?? []) {
            const r = findInParagraph(cellElement, text);
            if (r) return r;
          }
        }
      }
    }
  }
  return null;
}

function findInParagraph(
  element: docs_v1.Schema$StructuralElement,
  text: string,
): { start: number; end: number } | null {
  if (!element.paragraph) return null;
  for (const run of element.paragraph.elements ?? []) {
    const content = run.textRun?.content ?? '';
    const idx = content.indexOf(text);
    if (idx !== -1 && run.startIndex != null) {
      return {
        start: run.startIndex + idx,
        end: run.startIndex + idx + text.length,
      };
    }
  }
  return null;
}

// Finds the range of the smallest deletable block containing the placeholder.
// Strategy: find the paragraph (or table row) that contains the placeholder and
// return its full range including the trailing newline character.
function findBlockRange(
  body: docs_v1.Schema$Body,
  text: string,
): { start: number; end: number } | null {
  const content = body.content ?? [];

  for (const element of content) {
    // Paragraph-level block
    if (element.paragraph) {
      const found = findInParagraph(element, text);
      if (found && element.startIndex != null && element.endIndex != null) {
        return { start: element.startIndex, end: element.endIndex };
      }
    }

    // Table-level block: delete the entire row containing the placeholder
    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        let rowContainsPlaceholder = false;
        for (const cell of row.tableCells ?? []) {
          for (const cellElement of cell.content ?? []) {
            if (findInParagraph(cellElement, text)) {
              rowContainsPlaceholder = true;
            }
          }
        }
        if (rowContainsPlaceholder && row.startIndex != null && row.endIndex != null) {
          return { start: row.startIndex, end: row.endIndex };
        }
      }
    }
  }

  return null;
}
