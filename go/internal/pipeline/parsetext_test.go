package pipeline

import (
	"reflect"
	"testing"
)

func TestParseCaption(t *testing.T) {
	t.Run("parses simple title, body, and hashtags", func(t *testing.T) {
		input := "Title Line\nBody Line One\nBody Line Two\n#tag1 #tag2"
		res := ParseCaption(input)

		if res.Title != "Title Line" {
			t.Errorf("expected title 'Title Line', got %q", res.Title)
		}
		expectedBody := "Body Line One\nBody Line Two"
		if res.CaptionBody != expectedBody {
			t.Errorf("expected body %q, got %q", expectedBody, res.CaptionBody)
		}
		expectedTags := []string{"#tag1", "#tag2"}
		if !reflect.DeepEqual(res.Hashtags, expectedTags) {
			t.Errorf("expected hashtags %v, got %v", expectedTags, res.Hashtags)
		}
	})

	t.Run("handles single-line input", func(t *testing.T) {
		input := "Only Title Here #tag1"
		res := ParseCaption(input)

		if res.Title != "Only Title Here" {
			t.Errorf("expected title 'Only Title Here', got %q", res.Title)
		}
		if res.CaptionBody != "" {
			t.Errorf("expected empty body, got %q", res.CaptionBody)
		}
		expectedTags := []string{"#tag1"}
		if !reflect.DeepEqual(res.Hashtags, expectedTags) {
			t.Errorf("expected hashtags %v, got %v", expectedTags, res.Hashtags)
		}
	})

	t.Run("deduplicates hashtags preserving order", func(t *testing.T) {
		input := "Title\nBody #tag2 #tag1 #tag2"
		res := ParseCaption(input)

		expectedTags := []string{"#tag2", "#tag1"}
		if !reflect.DeepEqual(res.Hashtags, expectedTags) {
			t.Errorf("expected hashtags %v, got %v", expectedTags, res.Hashtags)
		}
	})

	t.Run("collapses multiple consecutive newlines", func(t *testing.T) {
		input := "Title\nLine 1\n\n\n\nLine 2"
		res := ParseCaption(input)

		expectedBody := "Line 1\n\nLine 2"
		if res.CaptionBody != expectedBody {
			t.Errorf("expected body %q, got %q", expectedBody, res.CaptionBody)
		}
	})
}
