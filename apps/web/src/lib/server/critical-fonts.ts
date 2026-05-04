import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import subsetFont from 'subset-font';
import { parse, type HTMLElement, NodeType, type TextNode } from 'node-html-parser';
import { FONTS, FONT_FAMILIES, type FontKey } from '$lib/fonts';
import { unicodeRange } from '$lib/utils';

const FONTS_DIR = resolve(process.cwd(), '../../packages/svelte/static/fonts');

const FONT_BUFFERS = new Map<string, Buffer>();
function loadFont(file: string): Buffer {
  let buf = FONT_BUFFERS.get(file);
  if (!buf) {
    buf = readFileSync(join(FONTS_DIR, file));
    FONT_BUFFERS.set(file, buf);
  }
  return buf;
}

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

export function fontFromHtmlElement(element: HTMLElement): FontKey | null {
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

export function collectFontData(html: string): Record<FontKey, FontData> {
  const data = {} as Record<FontKey, FontData>;
  for (const key of Object.keys(FONTS) as FontKey[]) {
    data[key] = { chars: new Set(), weights: new Set([400]) };
  }

  const body = parse(html).querySelector('body');
  if (!body) return data;

  for (const element of body.querySelectorAll('*')) {
    const key = fontFromHtmlElement(element);
    if (!key) continue;
    const bucket = data[key];
    for (const classList of element.classList.values()) {
      const weight = WEIGHT_MAP[classList];
      if (weight !== undefined) bucket.weights.add(weight);
    }
    for (const child of element.childNodes) {
      if (child.nodeType !== NodeType.TEXT_NODE) continue;
      for (const char of (child as TextNode).text) {
        if (char === ' ' || char.trim()) bucket.chars.add(char);
      }
    }
  }
  return data;
}

export async function injectCriticalFonts(html: string): Promise<string> {
  const data = collectFontData(html);
  const usedKeys = (Object.keys(FONTS) as FontKey[]).filter((key) => data[key].chars.size > 0);
  if (!usedKeys.length) return html;

  const fontFaces = await Promise.all(
    usedKeys.map(async (key) => {
      const { file, family, style } = FONTS[key];
      const { chars, weights } = data[key];
      const min = Math.min(...weights);
      const max = Math.max(...weights);
      const isFixedWeight = min === max;

      const subset = await subsetFont(loadFont(file), [...chars].join(''), {
        targetFormat: 'woff2',
        variationAxes: isFixedWeight ? { wght: min } : { wght: { min, max } }
      });
      const b64 = Buffer.from(subset).toString('base64');

      return (
        `@font-face{font-family:'${family}-Inline';` +
        `src:url(data:font/woff2;base64,${b64}) format('woff2');` +
        `font-weight:${isFixedWeight ? min : `${min} ${max}`};` +
        `font-style:${style};font-display:block;` +
        `unicode-range:${unicodeRange(chars)}}`
      );
    })
  );

  const usedFamilies = new Set(usedKeys.map((key) => FONTS[key].family));
  const rootRule = [...usedFamilies]
    .flatMap((family) => {
      const { stack, cssVariables } = FONT_FAMILIES[family];
      const stackCss = stack.map((fontFamily) => `'${fontFamily}'`).join(',');
      return cssVariables.map((cssVariable) => `${cssVariable}:${stackCss}`);
    })
    .join(';');

  const styleTag =
    `<style data-critical-font>` + fontFaces.join('') + `:root{${rootRule}}` + `</style>`;
  return html.replace(/<\/head>/i, `${styleTag}</head>`);
}
