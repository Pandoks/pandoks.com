export const getSlugFromBlogTitle = (title: string): string => {
  return title.replaceAll(' ', '-').toLowerCase();
};

export const hex = (n: number) => n.toString(16).toUpperCase();

export function unicodeRange(chars: Set<string>): string {
  const codepoints = [...chars].map((char) => char.codePointAt(0)!).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const codepoint of codepoints) {
    const last = ranges.at(-1);
    if (last && codepoint === last[1] + 1) last[1] = codepoint;
    else ranges.push([codepoint, codepoint]);
  }
  return ranges
    .map(([start, end]) => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`))
    .join(',');
}
