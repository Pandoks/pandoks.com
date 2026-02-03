const WORD_BOUNDARY_REGEX = /\b\w/g;

export function formatTitle(value: string) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(WORD_BOUNDARY_REGEX, (match) => match.toUpperCase());
}
