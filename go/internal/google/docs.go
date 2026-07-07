package google

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	googledocs "google.golang.org/api/docs/v1"
	"google.golang.org/api/option"
)

func newDocsService(ctx context.Context, client *http.Client) (*googledocs.Service, error) {
	return googledocs.NewService(ctx, option.WithHTTPClient(client))
}

// FillDoc fills a Google Doc with the campaign content.
//
// Phase A: text replacements (one batchUpdate, four replaceAllText).
// Phase B: image slots 10→1, each with a fresh documents.get to avoid index
//          invalidation — identical to the TS implementation's explicit design choice.
func FillDoc(
	ctx context.Context,
	client *http.Client,
	docID, title, captionBody string,
	hashtags []string,
	images []ImageSlot,
) error {
	svc, err := newDocsService(ctx, client)
	if err != nil {
		return fmt.Errorf("docs service: %w", err)
	}

	// ── Phase A: text replacements ────────────────────────────────────────────
	_, err = svc.Documents.BatchUpdate(docID, &googledocs.BatchUpdateDocumentRequest{
		Requests: []*googledocs.Request{
			replaceText("{{TITLE}}", title),
			replaceText("{{CAPTION}}", captionBody),
			replaceText("{{HASHTAGS}}", strings.Join(hashtags, " ")),
			replaceText("{{NUMBER_OF_POSTS}}", fmt.Sprintf("%d", len(images))),
		},
	}).Context(ctx).Do()
	if err != nil {
		return fmt.Errorf("phase A batchUpdate: %w", err)
	}

	// ── Phase B: image slots 10 → 1 ──────────────────────────────────────────
	for n := 10; n >= 1; n-- {
		placeholder := fmt.Sprintf("{{IMAGE_%d}}", n)
		var slot *ImageSlot
		if n <= len(images) {
			s := images[n-1]
			slot = &s
		}

		// Re-fetch doc on every iteration to get fresh character indices.
		doc, err := svc.Documents.Get(docID).Context(ctx).Do()
		if err != nil {
			return fmt.Errorf("phase B get doc (slot %d): %w", n, err)
		}

		if slot != nil {
			// Replace placeholder text with inline image.
			r := findTextRange(doc.Body, placeholder)
			if r == nil {
				slog.Warn("placeholder not found in doc — skipping", "placeholder", placeholder)
				continue
			}
			_, err = svc.Documents.BatchUpdate(docID, &googledocs.BatchUpdateDocumentRequest{
				Requests: []*googledocs.Request{
					{
						DeleteContentRange: &googledocs.DeleteContentRangeRequest{
							Range: &googledocs.Range{
								StartIndex: r.start,
								EndIndex:   r.end,
							},
						},
					},
					{
						InsertInlineImage: &googledocs.InsertInlineImageRequest{
							Location: &googledocs.Location{Index: r.start},
							Uri:      slot.PublicURL,
						},
					},
				},
			}).Context(ctx).Do()
			if err != nil {
				return fmt.Errorf("phase B insert image (slot %d): %w", n, err)
			}
		} else {
			// Delete the entire block containing this placeholder.
			r := findBlockRange(doc.Body, placeholder)
			if r == nil {
				slog.Warn("block for placeholder not found — skipping", "placeholder", placeholder)
				continue
			}
			_, err = svc.Documents.BatchUpdate(docID, &googledocs.BatchUpdateDocumentRequest{
				Requests: []*googledocs.Request{
					{
						DeleteContentRange: &googledocs.DeleteContentRangeRequest{
							Range: &googledocs.Range{
								StartIndex: r.start,
								EndIndex:   r.end,
							},
						},
					},
				},
			}).Context(ctx).Do()
			if err != nil {
				return fmt.Errorf("phase B delete block (slot %d): %w", n, err)
			}
		}
	}

	return nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func replaceText(find, replace string) *googledocs.Request {
	return &googledocs.Request{
		ReplaceAllText: &googledocs.ReplaceAllTextRequest{
			ContainsText: &googledocs.SubstringMatchCriteria{
				Text:      find,
				MatchCase: true,
			},
			ReplaceText: replace,
		},
	}
}

type charRange struct {
	start int64
	end   int64
}

// findTextRange locates the exact character range of a literal string inside the doc body.
// Searches paragraphs at top level and inside table cells — mirrors findTextRange in docs.ts.
func findTextRange(body *googledocs.Body, text string) *charRange {
	for _, elem := range body.Content {
		if r := findInParagraph(elem, text); r != nil {
			return r
		}
		if elem.Table != nil {
			for _, row := range elem.Table.TableRows {
				for _, cell := range row.TableCells {
					for _, cellElem := range cell.Content {
						if r := findInParagraph(cellElem, text); r != nil {
							return r
						}
					}
				}
			}
		}
	}
	return nil
}

func findInParagraph(elem *googledocs.StructuralElement, text string) *charRange {
	if elem.Paragraph == nil {
		return nil
	}
	for _, run := range elem.Paragraph.Elements {
		if run.TextRun == nil {
			continue
		}
		content := run.TextRun.Content
		idx := strings.Index(content, text)
		if idx != -1 {
			return &charRange{
				start: run.StartIndex + int64(idx),
				end:   run.StartIndex + int64(idx) + int64(len(text)),
			}
		}
	}
	return nil
}

// findBlockRange returns the range of the smallest deletable block (paragraph
// or table row) that contains the placeholder text.
//
// IMPORTANT: endIndex is decremented by 1 to exclude the trailing newline —
// the Docs API rejects deleteContentRange when the range includes the trailing
// newline of a paragraph or table row. This matches the TS findBlockRange exactly.
func findBlockRange(body *googledocs.Body, text string) *charRange {
	for _, elem := range body.Content {
		if elem.Paragraph != nil {
			if findInParagraph(elem, text) != nil {
				return &charRange{
					start: elem.StartIndex,
					end:   elem.EndIndex - 1,
				}
			}
		}
		if elem.Table != nil {
			for _, row := range elem.Table.TableRows {
				rowContains := false
				for _, cell := range row.TableCells {
					for _, cellElem := range cell.Content {
						if findInParagraph(cellElem, text) != nil {
							rowContains = true
						}
					}
				}
				if rowContains {
					return &charRange{
						start: row.StartIndex,
						end:   row.EndIndex - 1,
					}
				}
			}
		}
	}
	return nil
}
