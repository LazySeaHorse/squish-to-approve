package pipeline

import (
	"reflect"
	"testing"
)

func TestStripMarkdown(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain text",
			input:    "Hello world",
			expected: "Hello world",
		},
		{
			name:     "bold text with asterisks",
			input:    "This is *bold* text",
			expected: "This is bold text",
		},
		{
			name:     "bold text with double asterisks",
			input:    "This is **bold** text",
			expected: "This is bold text",
		},
		{
			name:     "italic text with underscores",
			input:    "This is _italic_ text",
			expected: "This is italic text",
		},
		{
			name:     "strikethrough text with tildes",
			input:    "This is ~strikethrough~ text",
			expected: "This is strikethrough text",
		},
		{
			name:     "strikethrough text with double tildes",
			input:    "This is ~~strikethrough~~ text",
			expected: "This is strikethrough text",
		},
		{
			name:     "monospace text with single backticks",
			input:    "This is `monospace` text",
			expected: "This is monospace text",
		},
		{
			name:     "monospace text with triple backticks",
			input:    "This is ```monospace``` text",
			expected: "This is monospace text",
		},
		{
			name:     "nested formatting",
			input:    "This is *_bold and italic_* text",
			expected: "This is bold and italic text",
		},
		{
			name:     "multiple formatting in one line",
			input:    "This is *bold* and this is _italic_.",
			expected: "This is bold and this is italic.",
		},
		{
			name:     "do not touch underscores in URLs",
			input:    "Link: https://instagram.com/p/a_b_c/ and file_name.png",
			expected: "Link: https://instagram.com/p/a_b_c/ and file_name.png",
		},
		{
			name:     "punctuation handling",
			input:    "Is it *bold*? Yes, it is *bold*.",
			expected: "Is it bold? Yes, it is bold.",
		},
		{
			name:     "do not touch unmatched formatting characters",
			input:    "This is *unmatched and _also unmatched",
			expected: "This is *unmatched and _also unmatched",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual := StripMarkdown(tt.input)
			if actual != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, actual)
			}
		})
	}
}

func TestParseCaptionWithFormatting(t *testing.T) {
	input := "*My Campaign Title*\nThis is a *bold* paragraph with _italics_.\n#tag1 #tag2"
	expected := ParsedCaption{
		Title:       "My Campaign Title",
		CaptionBody: "This is a bold paragraph with italics.",
		Hashtags:    []string{"#tag1", "#tag2"},
	}

	actual := ParseCaption(input)
	if actual.Title != expected.Title {
		t.Errorf("expected Title %q, got %q", expected.Title, actual.Title)
	}
	if actual.CaptionBody != expected.CaptionBody {
		t.Errorf("expected CaptionBody %q, got %q", expected.CaptionBody, actual.CaptionBody)
	}
	if !reflect.DeepEqual(actual.Hashtags, expected.Hashtags) {
		t.Errorf("expected Hashtags %v, got %v", expected.Hashtags, actual.Hashtags)
	}
}
