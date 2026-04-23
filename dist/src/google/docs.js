"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fillDoc = fillDoc;
const googleapis_1 = require("googleapis");
const auth_1 = require("./auth");
const logger_1 = require("../logger");
function getDocs() {
    return googleapis_1.google.docs({ version: 'v1', auth: (0, auth_1.getOAuth2Client)() });
}
async function fillDoc(docId, title, captionBody, hashtags, images) {
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
                {
                    replaceAllText: {
                        containsText: { text: '{{NUMBER_OF_POSTS}}', matchCase: true },
                        replaceText: String(images.length),
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
        const body = docContent.data.body;
        if (slot) {
            // Replace the placeholder text with an inline image
            const range = findTextRange(body, placeholder);
            if (!range) {
                logger_1.logger.warn(`Placeholder ${placeholder} not found in doc — skipping`);
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
        }
        else {
            // Delete the entire block containing this placeholder
            const blockRange = findBlockRange(body, placeholder);
            if (!blockRange) {
                logger_1.logger.warn(`Block for ${placeholder} not found — skipping`);
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
function findTextRange(body, text) {
    for (const element of body.content ?? []) {
        const result = findInParagraph(element, text);
        if (result)
            return result;
        // Check inside table cells
        if (element.table) {
            for (const row of element.table.tableRows ?? []) {
                for (const cell of row.tableCells ?? []) {
                    for (const cellElement of cell.content ?? []) {
                        const r = findInParagraph(cellElement, text);
                        if (r)
                            return r;
                    }
                }
            }
        }
    }
    return null;
}
function findInParagraph(element, text) {
    if (!element.paragraph)
        return null;
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
// return its range excluding the trailing newline (endIndex - 1).
// Google Docs API rejects deleteContentRange operations that include the trailing newline.
function findBlockRange(body, text) {
    const content = body.content ?? [];
    for (const element of content) {
        // Paragraph-level block
        if (element.paragraph) {
            const found = findInParagraph(element, text);
            if (found && element.startIndex != null && element.endIndex != null) {
                return { start: element.startIndex, end: element.endIndex - 1 };
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
                    return { start: row.startIndex, end: row.endIndex - 1 };
                }
            }
        }
    }
    return null;
}
//# sourceMappingURL=docs.js.map