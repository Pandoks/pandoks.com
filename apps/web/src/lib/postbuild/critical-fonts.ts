import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import subsetFont from 'subset-font';
import { parse } from 'node-html-parser';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');
const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');

const WEIGHT_MAP: Record<string, number> = {
  'font-thin': 100,
  'font-extralight': 200,
  'font-light': 300,
  'font-normal': 400,
  'font-medium': 500,
  'font-semibold': 600,
  'font-bold': 700,
  'font-extrabold': 800,
  'font-black': 900
};

interface FontData {
  chars: Set<string>;
  weights: Set<number>;
}

interface PageFonts {
  inter: FontData;
  interItalic: FontData;
  garamond: FontData;
  garamondItalic: FontData;
}

function addChars(set: Set<string>, text: string) {
  for (const ch of text) {
    if (ch === ' ' || ch.trim()) set.add(ch);
  }
}

function addWeights(weights: Set<number>, el: ReturnType<typeof parse>) {
  weights.add(400);
  for (const e of [el, ...el.querySelectorAll('*')]) {
    for (const cls of (e.getAttribute('class') || '').split(/\s+/)) {
      if (cls in WEIGHT_MAP) weights.add(WEIGHT_MAP[cls]);
    }
  }
}

function collectFontData(html: string): PageFonts {
  const data: PageFonts = {
    inter: { chars: new Set(), weights: new Set() },
    interItalic: { chars: new Set(), weights: new Set() },
    garamond: { chars: new Set(), weights: new Set() },
    garamondItalic: { chars: new Set(), weights: new Set() }
  };

  const root = parse(html);
  const body = root.querySelector('body');
  if (!body) return data;

  for (const el of body.querySelectorAll('.font-garamond')) {
    addChars(data.garamond.chars, el.textContent);
    addWeights(data.garamond.weights, el);
  }

  for (const el of body.querySelectorAll('.font-garamond .italic')) {
    addChars(data.garamondItalic.chars, el.textContent);
    addWeights(data.garamondItalic.weights, el);
  }

  const interClone = parse(body.outerHTML);
  for (const el of interClone.querySelectorAll('.font-garamond, .font-mono, script, style')) {
    el.remove();
  }
  addChars(data.inter.chars, interClone.textContent);
  addWeights(data.inter.weights, interClone);

  for (const el of body.querySelectorAll('.font-inter .italic')) {
    addChars(data.interItalic.chars, el.textContent);
    addWeights(data.interItalic.weights, el);
  }

  return data;
}

async function subsetToBase64(
  fontPath: string,
  chars: Set<string>,
  weights: number[]
): Promise<string | null> {
  if (chars.size === 0) return null;
  const text = [...chars].join('');
  const fontBuffer = readFileSync(fontPath);
  const variationAxes =
    weights.length === 1
      ? { wght: weights[0] }
      : { wght: { min: weights[0], max: weights[weights.length - 1] } };
  const output = await subsetFont(fontBuffer, text, { targetFormat: 'woff2', variationAxes });
  return Buffer.from(output).toString('base64');
}

function unicodeRangeFromChars(chars: Set<string>): string {
  const codepoints = [...chars].map((c) => c.codePointAt(0)!).sort((a, b) => a - b);

  const ranges: [number, number][] = [];
  for (const cp of codepoints) {
    const last = ranges.at(-1);
    if (last && cp === last[1] + 1) {
      last[1] = cp;
    } else {
      ranges.push([cp, cp]);
    }
  }

  return ranges
    .map(([start, end]) =>
      start === end
        ? `U+${start.toString(16).toUpperCase()}`
        : `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`
    )
    .join(',');
}

export async function injectCriticalFonts(htmlPath: string) {
  try {
    const html = readFileSync(htmlPath, 'utf-8');
    const data = collectFontData(html);

    // Inline faces use a distinct family name so they never compete with the external faces in the font-matching algorithm
    const INLINE_FONTS = {
      Inter: {
        stack: [
          'Inter-Inline',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans',
          'sans-serif'
        ],
        cssVariables: ['--font-inter', '--font-sans']
      },
      'EB Garamond': {
        stack: [
          'EB Garamond-Inline',
          'EB Garamond',
          'ui-serif',
          'Georgia',
          'Cambria',
          'Times New Roman',
          'Times',
          'serif'
        ],
        cssVariables: ['--font-garamond', '--font-serif']
      }
    };

    const fonts = [
      { data: data.inter, file: 'Inter.woff2', family: 'Inter', style: 'normal', key: 'inter' },
      {
        data: data.interItalic,
        file: 'Inter-Italic.woff2',
        family: 'Inter',
        style: 'italic',
        key: 'inter-italic'
      },
      {
        data: data.garamond,
        file: 'EBGaramond.woff2',
        family: 'EB Garamond',
        style: 'normal',
        key: 'garamond'
      },
      {
        data: data.garamondItalic,
        file: 'EBGaramond-Italic.woff2',
        family: 'EB Garamond',
        style: 'italic',
        key: 'garamond-italic'
      }
    ];

    const styleTags: string[] = [];
    for (const { data, file, family, style, key } of fonts) {
      if (data.chars.size === 0) continue;
      const weights = [...data.weights].sort((a, b) => a - b);
      const b64 = await subsetToBase64(join(FONTS_DIR, file), data.chars, weights);
      if (!b64) continue;
      const unicodeRange = unicodeRangeFromChars(data.chars);
      const cssWeight =
        weights.length === 1 ? `${weights[0]}` : `${weights[0]} ${weights[weights.length - 1]}`;
      const face = `@font-face{font-family:'${family}-Inline';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${cssWeight};font-style:${style};font-display:block;unicode-range:${unicodeRange}}`;
      const { stack, cssVariables } = INLINE_FONTS[family as keyof typeof INLINE_FONTS];
      const stackCss = stack.map((s) => `'${s}'`).join(',');
      const override = `:root{${cssVariables.map((v) => `${v}:${stackCss}`).join(';')}}`;
      styleTags.push(`<style data-critical-font="${key}">${face}${override}</style>`);
    }

    if (styleTags.length === 0) return;

    const injected = html.replace(/([ \t]*)<\/head>/, (_, closeIndent: string) => {
      const childIndent = closeIndent + '  ';
      const block = styleTags.map((t) => `${childIndent}${t}`).join('\n');
      return `${block}\n${closeIndent}</head>`;
    });
    writeFileSync(htmlPath, injected);

    const totalKB = (Buffer.byteLength(styleTags.join('')) / 1024).toFixed(1);
    const relativePath = htmlPath.replace(BUILD_DIR, '');
    console.log(
      `criticalFonts: ${relativePath} — ${styleTags.length} font(s), ${totalKB} KB inline`
    );
  } catch (err) {
    const relativePath = htmlPath.replace(BUILD_DIR, '');
    console.error(`criticalFonts: Failed for ${relativePath}:`, err);
  }
}
