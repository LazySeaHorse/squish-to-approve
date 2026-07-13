package pipeline

import (
	"regexp"
	"strings"
)

// ParsedCaption is the result of parsing a raw caption string.
type ParsedCaption struct {
	Title       string
	CaptionBody string
	Hashtags    []string
}

var hashtagRe = regexp.MustCompile(`#[\w]+`)

var (
	boldRe   = regexp.MustCompile(`(^|\s)\*\*?([^\s*](?:[^*]*?[^\s*])?)\*\*?([\s.,!?;:]|$)`)
	italicRe = regexp.MustCompile(`(^|\s)_([^\s_](?:[^_]*?[^\s_])?)_([\s.,!?;:]|$)`)
	strikeRe = regexp.MustCompile(`(^|\s)~~?([^\s~](?:[^~]*?[^\s~])?)~~?([\s.,!?;:]|$)`)
	codeRe   = regexp.MustCompile("(^|\\s)`{1,3}([^\\s`](?:[^`]*?[^\\s`])?)`{1,3}([\\s.,!?;:]|$)")
)

// StripMarkdown removes WhatsApp/Markdown bold, italic, strikethrough, and code formatting.
func StripMarkdown(s string) string {
	for i := 0; i < 3; i++ {
		s = boldRe.ReplaceAllString(s, "$1$2$3")
		s = italicRe.ReplaceAllString(s, "$1$2$3")
		s = strikeRe.ReplaceAllString(s, "$1$2$3")
		s = codeRe.ReplaceAllString(s, "$1$2$3")
	}
	return s
}

// ParseCaption splits a raw caption into title, body, and deduplicated hashtags.
// Mirrors parseCaption in src/pipeline/parseText.ts exactly.
//
// Rules:
//   - Title: everything before the first \n, trimmed.
//   - If no \n: entire string is title, hashtags extracted from it, body is empty.
//   - Hashtags: all #word matches from the body, deduplicated in order.
//   - Body: body with hashtag tokens stripped, trailing whitespace trimmed per line,
//     runs of 3+ consecutive newlines collapsed to 2.
func ParseCaption(raw string) ParsedCaption {
	idx := strings.Index(raw, "\n")
	if idx == -1 {
		// Single-line input
		title := strings.TrimSpace(raw)
		hashtags := extractHashtags(raw)
		// Remove hashtag tokens from the title
		title = strings.TrimSpace(hashtagRe.ReplaceAllString(title, ""))
		return ParsedCaption{
			Title:       StripMarkdown(title),
			CaptionBody: "",
			Hashtags:    hashtags,
		}
	}

	title := strings.TrimSpace(raw[:idx])
	bodyRaw := raw[idx+1:]

	hashtags := extractHashtags(bodyRaw)

	// Strip hashtag tokens and clean up trailing whitespace
	body := hashtagRe.ReplaceAllString(bodyRaw, "")
	// Trim trailing spaces/tabs on each line
	lineTrailRe := regexp.MustCompile(`[ \t]+\n`)
	body = lineTrailRe.ReplaceAllString(body, "\n")
	lineEndRe := regexp.MustCompile(`[ \t]+$`)
	body = lineEndRe.ReplaceAllString(body, "")
	// Collapse 3+ consecutive newlines to 2
	multiNLRe := regexp.MustCompile(`\n{3,}`)
	body = multiNLRe.ReplaceAllString(body, "\n\n")
	body = strings.TrimSpace(body)

	return ParsedCaption{
		Title:       StripMarkdown(title),
		CaptionBody: StripMarkdown(body),
		Hashtags:    hashtags,
	}
}

func extractHashtags(text string) []string {
	matches := hashtagRe.FindAllString(text, -1)
	seen := make(map[string]bool)
	result := make([]string, 0, len(matches))
	for _, h := range matches {
		if !seen[h] {
			seen[h] = true
			result = append(result, h)
		}
	}
	return result
}
