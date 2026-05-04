import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import subsetFont from 'subset-font';
import { parse, type HTMLElement, NodeType, type TextNode } from 'node-html-parser';
import { FONTS, FONT_FAMILIES, type Font, type FontKey } from '$lib/fonts';
import { unicodeRange } from '$lib/utils';

const FONTS_DIR = resolve(process.cwd(), '../../packages/svelte/static/fonts');

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

type FontData = { chars: Set<string>; weights: Set<number> };

function fontFromHtmlElement(element: HTMLElement): FontKey | null {
  let italic = false;
  let family: 'inter' | 'garamond' = 'inter';
  for (let current: HTMLElement | null = element; current; current = current.parentNode) {
    const tag = current.tagName?.toLowerCase();
    if (tag === 'script' || tag === 'style') return null;

    const classList = current.classList;
    if (classList.contains('font-mono')) return null;
    if (classList.contains('italic')) italic = true;
    if (classList.contains('font-garamond')) {
      family = 'garamond';
      break;
    }
    if (classList.contains('font-inter')) break;
  }
  return italic ? `${family}-italic` : family;
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
    .map(([s, e]) =>
      s === e
        ? `U+${s.toString(16).toUpperCase()}`
        : `U+${s.toString(16).toUpperCase()}-${e.toString(16).toUpperCase()}`
    )
    .join(',');
}

export async function injectCriticalFonts(html: string): Promise<string> {
  try {
    const data = collectFontData(html);
    const dataByKey: Record<(typeof FONTS)[number]['key'], FontData> = {
      inter: data.inter,
      'inter-italic': data.interItalic,
      garamond: data.garamond,
      'garamond-italic': data.garamondItalic
    };

    const styleTags: string[] = [];
    for (const { file, family, style, key } of FONTS) {
      const fontData = dataByKey[key];
      if (fontData.chars.size === 0) continue;
      const weights = [...fontData.weights].sort((a, b) => a - b);
      const b64 = await subsetToBase64(join(FONTS_DIR, file), fontData.chars, weights);
      if (!b64) continue;
      const unicodeRange = unicodeRangeFromChars(fontData.chars);
      const cssWeight =
        weights.length === 1 ? `${weights[0]}` : `${weights[0]} ${weights[weights.length - 1]}`;
      const face = `@font-face{font-family:'${family}-Inline';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${cssWeight};font-style:${style};font-display:block;unicode-range:${unicodeRange}}`;
      const { stack, cssVariables } = FONT_FAMILIES[family as keyof typeof FONT_FAMILIES];
      const stackCss = stack.map((s) => `'${s}'`).join(',');
      const override = `:root{${cssVariables.map((v) => `${v}:${stackCss}`).join(';')}}`;
      styleTags.push(`<style data-critical-font="${key}">${face}${override}</style>`);
    }

    if (styleTags.length === 0) return html;

    return html.replace(/([ \t]*)<\/head>/, (_, closeIndent: string) => {
      const childIndent = closeIndent + '  ';
      const block = styleTags.map((t) => `${childIndent}${t}`).join('\n');
      return `${block}\n${closeIndent}</head>`;
    });
  } catch (err) {
    console.error('criticalFonts: failed', err);
    return html;
  }
}
