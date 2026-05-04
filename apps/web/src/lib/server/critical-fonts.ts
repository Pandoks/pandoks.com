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
  const styleTags: string[] = [];

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
