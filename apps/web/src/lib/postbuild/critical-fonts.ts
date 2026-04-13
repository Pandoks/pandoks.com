import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Font, woff2 } from 'fonteditor-core';
import { parse } from 'node-html-parser';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');
const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');

interface FontChars {
  inter: Set<string>;
  interItalic: Set<string>;
  garamond: Set<string>;
  garamondItalic: Set<string>;
}

function addChars(set: Set<string>, text: string) {
  for (const ch of text) {
    if (ch === ' ' || ch.trim()) set.add(ch);
  }
}

function collectChars(html: string): FontChars {
  const chars: FontChars = {
    inter: new Set(),
    interItalic: new Set(),
    garamond: new Set(),
    garamondItalic: new Set()
  };

  const root = parse(html);
  const body = root.querySelector('body');
  if (!body) return chars;

  for (const el of body.querySelectorAll('.font-garamond')) {
    addChars(chars.garamond, el.textContent);
  }

  for (const el of body.querySelectorAll('.font-garamond .italic')) {
    addChars(chars.garamondItalic, el.textContent);
  }

  const interClone = parse(body.outerHTML);
  for (const el of interClone.querySelectorAll('.font-garamond, .font-mono, script, style')) {
    el.remove();
  }
  addChars(chars.inter, interClone.textContent);

  for (const el of body.querySelectorAll('.font-inter .italic')) {
    addChars(chars.interItalic, el.textContent);
  }

  return chars;
}

function subsetToBase64(fontPath: string, chars: Set<string>): string | null {
  if (chars.size === 0) return null;
  const codepoints = [...chars].map((c) => c.codePointAt(0)!);
  const fontBuffer = readFileSync(fontPath);
  const font = Font.create(fontBuffer, { type: 'woff2', subset: codepoints });
  const output = font.write({ type: 'woff2' }) as ArrayBuffer;
  return Buffer.from(new Uint8Array(output)).toString('base64');
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
  const html = readFileSync(htmlPath, 'utf-8');
  const chars = collectChars(html);

  const fontFaces: string[] = [];
  const fonts: { chars: Set<string>; file: string; family: string; style: string }[] = [
    { chars: chars.inter, file: 'Inter.woff2', family: 'Inter', style: 'normal' },
    { chars: chars.interItalic, file: 'Inter-Italic.woff2', family: 'Inter', style: 'italic' },
    { chars: chars.garamond, file: 'EBGaramond.woff2', family: 'EB Garamond', style: 'normal' },
    {
      chars: chars.garamondItalic,
      file: 'EBGaramond-Italic.woff2',
      family: 'EB Garamond',
      style: 'italic'
    }
  ];

  for (const { chars: charSet, file, family, style } of fonts) {
    if (charSet.size === 0) continue;
    const b64 = subsetToBase64(join(FONTS_DIR, file), charSet);
    if (!b64) continue;
    const unicodeRange = unicodeRangeFromChars(charSet);
    fontFaces.push(
      `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-style:${style};font-display:block;unicode-range:${unicodeRange}}`
    );
  }

  if (fontFaces.length === 0) return;

  const styleTag = `<style data-critical-font>${fontFaces.join('')}</style>`;
  const injected = html.replace('</head>', `${styleTag}</head>`);
  writeFileSync(htmlPath, injected);

  const totalKB = (Buffer.byteLength(styleTag) / 1024).toFixed(1);
  const relativePath = htmlPath.replace(BUILD_DIR, '');
  console.log(`criticalFonts: ${relativePath} — ${fontFaces.length} font(s), ${totalKB} KB inline`);
}
