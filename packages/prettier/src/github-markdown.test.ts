import { format, type Options } from 'prettier';
import { describe, expect, it } from 'vitest';
import githubMarkdown from './github-markdown.ts';

const widths = Array.from({ length: 51 }, (_, index) => index + 10);
const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.split(' ');

const formatMarkdown = (
  markdown: string,
  printWidth = 100,
  proseWrap: Options['proseWrap'] = 'always'
) => format(markdown, { parser: 'markdown', plugins: [githubMarkdown], printWidth, proseWrap });

const contexts = (token: string) =>
  [
    ...filler.map((_, index) => `${filler.slice(0, index + 1).join(' ')} ${token} tail words`),
    `- list item ${token} tail words`,
    `> quoted ${token} tail words`,
    `[^9]: footnote ${token} tail words\n\nref[^9]`
  ].join('\n\n') + '\n';

const lineStarts = (markdown: string) =>
  markdown.split('\n').map((line) => line.replace(/^(?:\s*(?:>|-|\[\^9\]:))*\s*/, ''));

describe('github alerts', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'note'])(
    'keeps the %s marker on its own line',
    async (type) => {
      const markdown = `> [!${type}]\n> Body text that is long enough to be wrapped onto more lines.\n`;
      expect(await formatMarkdown(markdown, 40)).toBe(
        `> [!${type}]\n> Body text that is long enough to be\n> wrapped onto more lines.\n`
      );
    }
  );

  it('does not turn a same-line marker into an alert', async () => {
    const markdown = '> [!TIP] Same line text is a plain blockquote on GitHub.\n';
    expect(await formatMarkdown(markdown, 10)).toMatch(/^> \[!TIP\] Same\n/);
  });
});

describe('line starts', () => {
  it.each([
    '```',
    '~~~',
    '$$',
    '---',
    '===',
    ':---:',
    '| --- |',
    ':tada:',
    '[^1]:',
    '<div>',
    '</details>',
    '<source>',
    '<pre>',
    '<!-- comment -->',
    '<?php',
    '<!DOCTYPE',
    '<![CDATA['
  ])('never starts a line with %s', async (token) => {
    for (const width of widths) {
      const formatted = await formatMarkdown(contexts(token), width);
      expect(lineStarts(formatted).filter((line) => line.startsWith(token))).toEqual([]);
      expect(await formatMarkdown(formatted, width)).toBe(formatted);
    }
  });

  it('never ends a line with an escaping backslash', async () => {
    for (const width of widths) {
      const formatted = await formatMarkdown(contexts('\\'), width);
      expect(formatted.split('\n').filter((line) => line.endsWith('\\'))).toEqual([]);
    }
  });
});

describe('unchanged behavior', () => {
  it('does not wrap tables', async () => {
    const markdown = `| ${'long cell '.repeat(12).trim()} |\n| --- |\n| x |\n`;
    expect((await formatMarkdown(markdown, 20)).split('\n')).toHaveLength(4);
  });

  it('matches prettier when prose is preserved', async () => {
    const markdown = '> [!NOTE]\n> Keep this\n\nlorem <div> ipsum :tada:\n';
    expect(await formatMarkdown(markdown, 10, 'preserve')).toBe(
      await format(markdown, { parser: 'markdown', printWidth: 10, proseWrap: 'preserve' })
    );
  });
});
