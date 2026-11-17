// Snippets leave the index with these two control characters around each matched word, so the
// client can highlight without parsing markup. Indexed text never contains either character.
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

export interface SnippetPart { text: string; match: boolean }
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  for (const piece of snippet.split(/([\u0001\u0002])/)) {
    if (piece === MARK_OPEN) match = true;
    else if (piece === MARK_CLOSE) match = false;
    else if (piece) parts.push({ text: piece, match });
  }
  return parts;
}

/**
 * The rows a search box shows. With no search text every row stays in its original order. Otherwise a
 * row is shown when the index found the text in it (best match first) or when the old
 * title/path/provider substring check still matches, so partial words and folder fragments keep working.
 */
export function searchMatches<T>(
  items: readonly T[], needle: string,
  local: (item: T, needle: string) => boolean,
  hit: (item: T) => { rank: number } | undefined,
): T[] {
  if (!needle) return [...items];
  const ranked: Array<{ rank: number; item: T }> = [];
  const rest: T[] = [];
  for (const item of items) {
    const found = hit(item);
    if (found) ranked.push({ rank: found.rank, item });
    else if (local(item, needle)) rest.push(item);
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return [...ranked.map(({ item }) => item), ...rest];
}
