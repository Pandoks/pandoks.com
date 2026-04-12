import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { load as cheerioLoad } from 'cheerio';
import subsetFont from 'subset-font';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');
const TEMP_DIR = join(WEB_DIR, '.temp');
const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');

// --- Blog route restoration (existing logic) ---

export const restoreBlogRoutes = () => {
  const tempBlogDir = join(TEMP_DIR, 'src', 'routes', 'blog', '[title]');
  const blogDir = join(WEB_DIR, 'src', 'routes', 'blog');

  if (existsSync(tempBlogDir)) {
    execSync(`mv "${tempBlogDir}" "${join(blogDir, '[title]')}"`, { stdio: 'inherit' });
    console.log('restoreBlogRoutes: Restored blog routes from .temp directory');
  }
};

if (existsSync(TEMP_DIR)) {
  restoreBlogRoutes();
  execSync(`rm -rf "${TEMP_DIR}"`, { stdio: 'inherit' });
  console.log('postbuild: Removed .temp directory');
} else {
  console.log('postbuild: No .temp directory found');
}

// --- Critical font injection ---

interface FontChars {
  inter: Set<string>;
  interItalic: Set<string>;
  garamond: Set<string>;
  garamondItalic: Set<string>;
}

function collectChars(html: string): FontChars {
  const $ = cheerioLoad(html);
  const result: FontChars = {
    inter: new Set(),
    interItalic: new Set(),
    garamond: new Set(),
    garamondItalic: new Set()
  };

  function addChars(set: Set<string>, text: string) {
    for (const ch of text) {
      set.add(ch);
    }
  }

  function walk(el: Parameters<typeof $>[0], font: 'inter' | 'garamond', isItalic: boolean) {
    const $el = $(el);
    const classes = ($el.attr('class') || '').split(/\s+/);
    let currentFont = font;
    let currentItalic = isItalic;

    if (classes.includes('font-inter')) currentFont = 'inter';
    if (classes.includes('font-garamond')) currentFont = 'garamond';
    if (classes.includes('font-mono')) return;
    if (classes.includes('italic')) currentItalic = true;
    if (classes.includes('not-italic')) currentItalic = false;

    $el.contents().each((_, child: any) => {
      if (child.type === 'text' && child.data) {
        const key =
          currentFont === 'inter'
            ? currentItalic
              ? 'interItalic'
              : 'inter'
            : currentItalic
              ? 'garamondItalic'
              : 'garamond';
        addChars(result[key], child.data);
      } else if (child.type === 'tag') {
        walk(child, currentFont, currentItalic);
      }
    });
  }

  const body = $('body').get(0);
  if (body) {
    walk(body, 'inter', false);
  }

  return result;
}

async function subsetToBase64(fontPath: string, chars: Set<string>): Promise<string | null> {
  if (chars.size === 0) return null;
  const text = [...chars].join('');
  const fontBuffer = readFileSync(fontPath);
  const subset = await subsetFont(fontBuffer, text, {
    targetFormat: 'woff2',
    variationAxes: { wght: 400 }
  });
  return Buffer.from(subset).toString('base64');
}

function unicodeRangeFromChars(chars: Set<string>): string {
  const codepoints = [...chars]
    .map((c) => c.codePointAt(0)!)
    .sort((a, b) => a - b);
  const ranges: string[] = [];
  let i = 0;
  while (i < codepoints.length) {
    let start = codepoints[i];
    let end = start;
    while (i + 1 < codepoints.length && codepoints[i + 1] === end + 1) {
      i++;
      end = codepoints[i];
    }
    ranges.push(
      start === end
        ? `U+${start.toString(16).toUpperCase()}`
        : `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`
    );
    i++;
  }
  return ranges.join(', ');
}

function buildFontFace(
  family: string,
  b64: string,
  style: string,
  unicodeRange: string
): string {
  return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-style:${style};font-display:block;unicode-range:${unicodeRange}}`;
}

async function injectCriticalFonts(htmlPath: string) {
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
    const b64 = await subsetToBase64(join(FONTS_DIR, file), charSet);
    if (b64) {
      const unicodeRange = unicodeRangeFromChars(charSet);
      fontFaces.push(buildFontFace(family, b64, style, unicodeRange));
    }
  }

  if (fontFaces.length === 0) return;

  const styleTag = `<style data-critical-font>${fontFaces.join('')}</style>`;
  const injected = html.replace('</head>', `${styleTag}</head>`);
  writeFileSync(htmlPath, injected);

  const totalKB = (Buffer.byteLength(styleTag) / 1024).toFixed(1);
  const relativePath = htmlPath.replace(BUILD_DIR, '');
  console.log(
    `criticalFonts: ${relativePath} — ${fontFaces.length} font(s), ${totalKB} KB inline`
  );
}

function findHtmlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findHtmlFiles(full));
    } else if (entry.endsWith('.html')) {
      files.push(full);
    }
  }
  return files;
}

if (existsSync(BUILD_DIR)) {
  const htmlFiles = findHtmlFiles(BUILD_DIR);
  console.log(`criticalFonts: Processing ${htmlFiles.length} HTML files...`);
  await Promise.all(htmlFiles.map((f) => injectCriticalFonts(f)));
  console.log('criticalFonts: Done');
} else {
  console.log('criticalFonts: No build directory found, skipping');
}
