import { describe, it, expect } from 'vitest';
import { parse, type HTMLElement } from 'node-html-parser';
import { collectFontData, fontFromHtmlElement } from './critical-fonts';

const el = (html: string): HTMLElement =>
  parse(`<body>${html}</body>`).querySelector('body')!.firstChild as HTMLElement;

const wrap = (body: string) => `<html><body>${body}</body></html>`;

describe('fontFromHtmlElement', () => {
  it('defaults to inter when no font class is present in the ancestor chain', () => {
    expect(fontFromHtmlElement(el('<p>hi</p>'))).toBe('inter');
  });

  it('returns garamond when the element itself has font-garamond', () => {
    expect(fontFromHtmlElement(el('<p class="font-garamond">hi</p>'))).toBe('garamond');
  });

  it('returns inter-italic when italic is set without an explicit family', () => {
    expect(fontFromHtmlElement(el('<em class="italic">hi</em>'))).toBe('inter-italic');
  });

  it('returns garamond-italic when italic is below font-garamond', () => {
    const root = parse('<body><div class="font-garamond"><em class="italic">hi</em></div></body>');
    const em = root.querySelector('em')!;
    expect(fontFromHtmlElement(em)).toBe('garamond-italic');
  });

  it('inherits font-garamond from an ancestor', () => {
    const root = parse('<body><section class="font-garamond"><p>hi</p></section></body>');
    expect(fontFromHtmlElement(root.querySelector('p')!)).toBe('garamond');
  });

  it('stops walking once an explicit font-inter is found, ignoring outer font-garamond', () => {
    const root = parse(
      '<body><div class="font-garamond"><div class="font-inter"><p>hi</p></div></div></body>'
    );
    expect(fontFromHtmlElement(root.querySelector('p')!)).toBe('inter');
  });

  it('still applies italic collected before reaching an explicit font-inter ancestor', () => {
    const root = parse(
      '<body><div class="font-inter"><em class="italic">hi</em></div></body>'
    );
    expect(fontFromHtmlElement(root.querySelector('em')!)).toBe('inter-italic');
  });

  it('returns null when called on a <script> element directly', () => {
    const root = parse('<body><script>secret</script></body>');
    expect(fontFromHtmlElement(root.querySelector('script')!)).toBeNull();
  });

  it('returns null when called on a <style> element directly', () => {
    const root = parse('<body><style>x{}</style></body>');
    expect(fontFromHtmlElement(root.querySelector('style')!)).toBeNull();
  });

  it('returns null when font-mono is in the ancestor chain', () => {
    const root = parse('<body><div class="font-mono"><span>x</span></div></body>');
    expect(fontFromHtmlElement(root.querySelector('span')!)).toBeNull();
  });

  it('font-mono on the element itself returns null even if italic was collected', () => {
    const root = parse('<body><em class="italic"><code class="font-mono">x</code></em></body>');
    expect(fontFromHtmlElement(root.querySelector('code')!)).toBeNull();
  });
});

describe('collectFontData', () => {
  it('initializes every font key with weight 400 and an empty char set', () => {
    const data = collectFontData(wrap(''));
    for (const key of ['inter', 'inter-italic', 'garamond', 'garamond-italic'] as const) {
      expect(data[key].chars.size).toBe(0);
      expect([...data[key].weights]).toEqual([400]);
    }
  });

  it('returns the empty initial state when no <body> exists', () => {
    const data = collectFontData('<html><head></head></html>');
    expect(data.inter.chars.size).toBe(0);
    expect(data.garamond.chars.size).toBe(0);
  });

  it('routes plain text into the inter bucket', () => {
    const { inter, garamond } = collectFontData(wrap('<p>abc</p>'));
    expect([...inter.chars].sort()).toEqual(['a', 'b', 'c']);
    expect(garamond.chars.size).toBe(0);
  });

  it('routes font-garamond text into the garamond bucket', () => {
    const { garamond, inter } = collectFontData(wrap('<p class="font-garamond">xyz</p>'));
    expect([...garamond.chars].sort()).toEqual(['x', 'y', 'z']);
    expect(inter.chars.size).toBe(0);
  });

  it('keeps spaces but drops other whitespace characters', () => {
    const { inter } = collectFontData(wrap('<p>a b\nc\td</p>'));
    expect(inter.chars.has(' ')).toBe(true);
    expect(inter.chars.has('\n')).toBe(false);
    expect(inter.chars.has('\t')).toBe(false);
    for (const ch of ['a', 'b', 'c', 'd']) expect(inter.chars.has(ch)).toBe(true);
  });

  it('attributes only direct text children to each element, avoiding double-count across nested fonts', () => {
    const { inter, garamond } = collectFontData(
      wrap('<p>outer<span class="font-garamond">inner</span></p>')
    );
    expect([...inter.chars].sort().join('')).toBe('eortu');
    expect([...garamond.chars].sort().join('')).toBe('einr');
    expect(inter.chars.has('i')).toBe(false);
    expect(inter.chars.has('n')).toBe(false);
  });

  it('splits italic text into the matching italic bucket', () => {
    const { inter, 'inter-italic': interItalic } = collectFontData(
      wrap('<p>plain<em class="italic">slanted</em></p>')
    );
    expect([...inter.chars].sort().join('')).toBe('ailnp');
    expect([...interItalic.chars].sort().join('')).toBe('adelnst');
  });

  it('routes garamond italic correctly', () => {
    const data = collectFontData(
      wrap('<div class="font-garamond"><em class="italic">hi</em></div>')
    );
    expect([...data['garamond-italic'].chars].sort().join('')).toBe('hi');
    expect(data.garamond.chars.size).toBe(0);
    expect(data['inter-italic'].chars.size).toBe(0);
  });

  it('skips text inside <script> and <style>', () => {
    const { inter } = collectFontData(
      wrap('<p>visible</p><script>secret</script><style>hidden</style>')
    );
    expect([...inter.chars].sort().join('')).toBe('beilsv');
    for (const ch of 'secrt') expect(inter.chars.has(ch) && !'beilsv'.includes(ch)).toBe(false);
  });

  it('skips text inside font-mono', () => {
    const { inter } = collectFontData(wrap('<p>ab</p><code class="font-mono">xy</code>'));
    expect(inter.chars.has('a')).toBe(true);
    expect(inter.chars.has('b')).toBe(true);
    expect(inter.chars.has('x')).toBe(false);
    expect(inter.chars.has('y')).toBe(false);
  });

  it('collects font-weight tailwind classes into the weights set', () => {
    const { inter } = collectFontData(
      wrap('<p class="font-bold">a</p><span class="font-light">b</span>')
    );
    expect([...inter.weights].sort((a, b) => a - b)).toEqual([300, 400, 700]);
  });

  it('always retains the default 400 weight even when no weight class is used', () => {
    const { inter } = collectFontData(wrap('<p>x</p>'));
    expect(inter.weights.has(400)).toBe(true);
    expect(inter.weights.size).toBe(1);
  });

  it('ignores classes that are not in the WEIGHT_MAP', () => {
    const { inter } = collectFontData(wrap('<p class="text-lg my-cool-class">x</p>'));
    expect([...inter.weights]).toEqual([400]);
  });

  it('recognizes every supported tailwind weight class', () => {
    const { inter } = collectFontData(
      wrap(
        '<p class="font-thin">a</p>' +
          '<p class="font-extralight">b</p>' +
          '<p class="font-light">c</p>' +
          '<p class="font-normal">d</p>' +
          '<p class="font-medium">e</p>' +
          '<p class="font-semibold">f</p>' +
          '<p class="font-bold">g</p>' +
          '<p class="font-extrabold">h</p>' +
          '<p class="font-black">i</p>'
      )
    );
    expect([...inter.weights].sort((a, b) => a - b)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900
    ]);
  });

  it('routes weight classes to the correct font bucket', () => {
    const data = collectFontData(
      wrap(
        '<p class="font-bold">a</p>' +
          '<p class="font-garamond font-light">b</p>' +
          '<em class="italic font-medium">c</em>'
      )
    );
    expect(data.inter.weights.has(700)).toBe(true);
    expect(data.garamond.weights.has(300)).toBe(true);
    expect(data['inter-italic'].weights.has(500)).toBe(true);
    expect(data.inter.weights.has(300)).toBe(false);
    expect(data.garamond.weights.has(700)).toBe(false);
  });

  it('handles elements with no class attribute without crashing', () => {
    const { inter } = collectFontData(wrap('<p>hi</p>'));
    expect([...inter.weights]).toEqual([400]);
    expect(inter.chars.size).toBe(2);
  });

  it('handles elements with empty class attribute', () => {
    const { inter } = collectFontData(wrap('<p class="">hi</p>'));
    expect([...inter.weights]).toEqual([400]);
  });

  it('deduplicates repeated characters within a bucket', () => {
    const { inter } = collectFontData(wrap('<p>aaa</p><span>aab</span>'));
    expect([...inter.chars].sort()).toEqual(['a', 'b']);
  });
});
