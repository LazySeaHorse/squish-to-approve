export interface ParsedCaption {
  title: string;
  captionBody: string;
  hashtags: string[];
}

export function parseCaption(raw: string): ParsedCaption {
  const newlineIdx = raw.indexOf('\n');

  if (newlineIdx === -1) {
    // Single-line text: treat the whole thing as the title, no body
    const title = raw.trim();
    const hashtags = extractHashtags(raw);
    return { title: title.replace(/#[\w]+/g, '').trim(), captionBody: '', hashtags };
  }

  const title = raw.slice(0, newlineIdx).trim();
  const bodyRaw = raw.slice(newlineIdx + 1);

  const hashtags = extractHashtags(bodyRaw);

  // Strip hashtag tokens and trailing whitespace they leave behind
  let captionBody = bodyRaw.replace(/#[\w]+/g, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]+$/gm, '');

  // Collapse runs of 3+ consecutive newlines into 2
  captionBody = captionBody.replace(/\n{3,}/g, '\n\n').trim();

  return { title, captionBody, hashtags };
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\w]+/g) ?? [];
  // Deduplicate preserving order
  const seen = new Set<string>();
  return matches.filter(h => {
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}
