import { format, type Options } from 'prettier';
import { describe, expect, it } from 'vitest';
import githubMarkdown from './github-markdown.ts';

// printWidth 1 tries a line break at every space
const formatMarkdown = (markdown: string, options?: Options) =>
  format(markdown, {
    parser: 'markdown',
    plugins: [githubMarkdown],
    printWidth: 1,
    proseWrap: 'always',
    ...options
  });

describe('github alerts', () => {
  it.each(['WARNING', 'caution'])('keeps the %s marker on its own line', async (type) => {
    const markdown = `> [!${type}]\n> lorem\n`;
    expect(await formatMarkdown(markdown, { printWidth: 80 })).toBe(markdown);
  });

  it('keeps the marker on its own line when prose is preserved', async () => {
    const markdown = '> [!IMPORTANT]\n> 2)\n';
    expect(await formatMarkdown(markdown, { proseWrap: 'preserve' })).toBe(markdown);
  });

  it('does not turn a same-line marker into an alert', async () => {
    expect(await formatMarkdown('> [!TIP] lorem tail\n')).toBe('> [!TIP] lorem\n> tail\n');
  });

  it('keeps text joined to the marker', async () => {
    expect(await formatMarkdown('> [!NOTE]中文\n')).toBe('> [!NOTE]中文\n');
  });

  it.each([
    ['[!NOTE] lorem\n', '[!NOTE]\nlorem\n'],
    ['> [!NOTE]x lorem\n', '> [!NOTE]x\n> lorem\n'],
    ['> x[!NOTE] lorem\n', '> x[!NOTE]\n> lorem\n'],
    ['> >\n>\n> [!NOTE] lorem\n', '> >\n>\n> [!NOTE]\n> lorem\n']
  ])('wraps a marker that does not form an alert in %j', async (markdown, formatted) => {
    expect(await formatMarkdown(markdown)).toBe(formatted);
  });
});

describe('line breaks', () => {
  it.each([
    '```',
    '~~~',
    '$$x',
    '= ==',
    '---:',
    '***',
    '__ _',
    ':-|',
    '| --- |',
    ':-1:',
    '[^ab]:',
    '{{ x }}',
    '{% x %}',
    '</DETAILS>',
    '<table x>',
    '<hr/>',
    '<div',
    '<script>',
    '<pre>',
    '<style x>',
    '<textarea',
    '<!-- x -->',
    '<?php',
    '>中'
  ])('never starts a line with %s', async (token) => {
    expect(await formatMarkdown(`lorem ipsum ${token}\n`)).toBe(`lorem\nipsum ${token}\n`);
  });

  it('never starts a list or heading inside a reference link', async () => {
    const definition = '\n\n[a + # ###### 01. 000000001. 1) 21. 0000000001. b]: /u\n';
    expect(
      await formatMarkdown(`[a + # ###### 01. 000000001. 1) 21. 0000000001. b]${definition}`)
    ).toBe(`[a + # ###### 01. 000000001. 1)\n21.\n0000000001.\nb]${definition}`);
  });

  it('never breaks inside a reference link or footnote in a blockquote', async () => {
    expect(await formatMarkdown('> - [a\\] b\\] c] [^d [] e]\n\n[a\\] b\\] c]: /u\n')).toBe(
      '> - [a\\] b\\] c]\n>   [^d [] e]\n\n[a\\] b\\] c]: /u\n'
    );
  });

  it('never starts a line with an emoji shortcode after emphasis markers', async () => {
    expect(await formatMarkdown('**lorem **:+1:****\n')).toBe('**lorem **:+1:****\n');
  });

  it.each([
    '</A> lorem\n',
    `<A b=">" c='d' e="" f=''> lorem\n`,
    'lorem  \n*\n``` lorem `x`\n',
    '___ lorem  \n=== lorem\n',
    '$$ lorem $  \n$$$ lorem $\n',
    'a|b  \n:-- | --: tail\n',
    '> [!NOTE]\n> *** lorem\n',
    'lorem  \n2. ---\n'
  ])('never leaves a block on its own line in %j', async (markdown) => {
    expect(await formatMarkdown(markdown)).toBe(markdown);
  });

  it('never leaves a liquid tag on its own line', async () => {
    expect(await formatMarkdown('lorem  \n{{\u2028}} tail ipsum  \n{%%} tail  \n{a} tail\n')).toBe(
      'lorem  \n{{\u2028}} tail\nipsum  \n{%%} tail  \n{a}\ntail\n'
    );
  });

  it.each([
    ['[a`]:\tb\t"c` d" tail\n', '[a`]:\tb\t"c`\nd" tail\n'],
    ["[a]: <b\\> c\\\nd> 'e' tail\n", "[a]: <b\\> c\\\nd> 'e' tail\n"],
    ['[a]:\u00a0 b tail\n', '[a]:\u00a0 b\ntail\n'],
    ['[a]:b\u00a0c () tail\n', '[a]:b\u00a0c () tail\n'],
    ['[a\\]\\\nb]:b\u00a0"c d" tail\n', '[a\\]\\\nb]:b\u00a0"c d"\ntail\n'],
    ['[a\\]: b tail\n', '[a\\]:\nb\ntail\n'],
    ['[a]:  \nb "c  \nd" tail\n', '[a]:  \nb "c  \nd" tail\n']
  ])('never ends a line like a link reference definition in %j', async (markdown, formatted) => {
    expect(await formatMarkdown(markdown)).toBe(formatted);
  });

  it.each(['+', '1.', '1)'])(
    'never joins a lone %s list marker after a hard break',
    async (marker) => {
      const markdown = `lorem  \n${marker}\nipsum\n`;
      expect(await formatMarkdown(markdown, { printWidth: 80 })).toBe(markdown);
    }
  );

  it('never ends a line with an escaping backslash', async () => {
    expect(await formatMarkdown('\\ lorem\n')).toBe('\\ lorem\n');
  });

  it('never breaks inside one-line footnote brackets', async () => {
    expect(await formatMarkdown('[^ [] [c d] e] [^f  \ng h] [^i j\n')).toBe(
      '[^ [] [c d] e]\n[^f  \ng\nh]\n[^i\nj\n'
    );
  });

  it('moves joined words to the next line when they do not fit', async () => {
    expect(await formatMarkdown('lorem ipsum dolor ---\n', { printWidth: 18 })).toBe(
      'lorem ipsum\ndolor ---\n'
    );
  });

  it.each([
    [
      '<1> $5 ~~a~~ [^a] [a b] :a `` _:+1:_ :: {x [^]: <pre_ ####### +b\n',
      '<1>\n$5\n~~a~~\n[^a]\n[a\nb]\n:a\n``\n_:+1:_\n::\n{x\n[^]:\n<pre_\n#######\n+b\n'
    ],
    [
      '[]: b  \n`` c  \n$ c  \n2. c  \n<a b="x> c  \n[a] b]: c  \n```` `x` c\n',
      '[]:\nb  \n``\nc  \n$\nc  \n2.\nc  \n<a\nb="x>\nc  \n[a]\nb]:\nc  \n```` `x`\nc\n'
    ]
  ])('still breaks before look-alikes in %j', async (markdown, formatted) => {
    expect(await formatMarkdown(markdown)).toBe(formatted);
  });
});

describe('unwrapped blocks', () => {
  it('does not wrap setext headings or link reference definitions', async () => {
    const markdown = 'lorem\n_a ```_\n===\n\n[a]: # "b c"\n';
    expect(await formatMarkdown(markdown)).toBe(markdown);
  });

  it('does not wrap embedded code', async () => {
    const markdown = '```yaml\nkey:\n  lorem ipsum\n  dolor\n```\n';
    expect(await formatMarkdown(markdown)).toBe(markdown);
  });
});
