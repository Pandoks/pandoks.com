import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { Font, woff2 } from 'fonteditor-core';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');
const TEMP_DIR = join(WEB_DIR, '.temp');
const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');

// ────────────────────────────────────────────
// Blog route restoration
// ────────────────────────────────────────────

function restoreBlogRoutes() {
  if (!existsSync(TEMP_DIR)) {
    console.log('postbuild: No .temp directory found');
    return;
  }

  const tempBlogDir = join(TEMP_DIR, 'src', 'routes', 'blog', '[title]');
  const blogDir = join(WEB_DIR, 'src', 'routes', 'blog');

  if (existsSync(tempBlogDir)) {
    execSync(`mv "${tempBlogDir}" "${join(blogDir, '[title]')}"`, { stdio: 'inherit' });
    console.log('postbuild: Restored blog routes from .temp directory');
  }

  execSync(`rm -rf "${TEMP_DIR}"`, { stdio: 'inherit' });
  console.log('postbuild: Removed .temp directory');
}

// ────────────────────────────────────────────
// Critical font injection
// ────────────────────────────────────────────

interface FontChars {
  inter: Set<string>;
  interItalic: Set<string>;
  garamond: Set<string>;
  garamondItalic: Set<string>;
}

/** Walk HTML and collect characters grouped by font-family and style. */
function collectChars(html: string): FontChars {
  const chars: FontChars = {
    inter: new Set(),
    interItalic: new Set(),
    garamond: new Set(),
    garamondItalic: new Set()
  };

  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
  const clean = body.replace(/<script[\s\S]*?<\/script>/g, '');

  let pos = 0;
  function walk(font: 'inter' | 'garamond' | 'mono', italic: boolean) {
    while (pos < clean.length) {
      if (clean[pos] === '<') {
        const end = clean.indexOf('>', pos);
        if (end === -1) break;
        const tag = clean.substring(pos, end + 1);
        pos = end + 1;

        if (tag[1] === '/') return;
        if (tag.endsWith('/>') || tag.startsWith('<!--')) continue;

        let childFont: typeof font = font;
        let childItalic = italic;
        const cls = tag.match(/class="([^"]*)"/)?.[1] || '';
        if (cls.includes('font-inter')) childFont = 'inter';
        if (cls.includes('font-garamond')) childFont = 'garamond';
        if (cls.includes('font-mono')) childFont = 'mono';
        if (/\bitalic\b/.test(cls)) childItalic = true;
        if (/\bnot-italic\b/.test(cls)) childItalic = false;

        walk(childFont, childItalic);
      } else {
        const ch = clean[pos];
        if (font !== 'mono' && (ch === ' ' || ch.trim())) {
          const key: keyof FontChars =
            font === 'garamond'
              ? italic
                ? 'garamondItalic'
                : 'garamond'
              : italic
                ? 'interItalic'
                : 'inter';
          chars[key].add(ch);
        }
        pos++;
      }
    }
  }

  walk('inter', false);
  return chars;
}

function subsetToBase64(fontPath: string, chars: Set<string>): string | null {
  if (chars.size === 0) return null;
  const codepoints = [...chars].map((c) => c.codePointAt(0)!);
  const fontBuffer = readFileSync(fontPath);
  const font = Font.create(fontBuffer, { type: 'woff2', subset: codepoints });
  const output = font.write({ type: 'woff2' });
  return Buffer.from(output).toString('base64');
}

function unicodeRangeFromChars(chars: Set<string>): string {
  const codepoints = [...chars].map((c) => c.codePointAt(0)!).sort((a, b) => a - b);
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

function injectCriticalFonts(htmlPath: string) {
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

// ────────────────────────────────────────────
// Route list injection (for client-side preloading)
// ────────────────────────────────────────────

function injectRouteList(htmlFiles: string[]) {
  const allRoutes = htmlFiles.map((f) => {
    const rel = f
      .replace(BUILD_DIR, '')
      .replace(/\/index\.html$/, '/')
      .replace(/\.html$/, '');
    return rel || '/';
  });

  const script = `<script>window.__ALL_ROUTES=${JSON.stringify(allRoutes)}</script>`;

  for (const f of htmlFiles) {
    const html = readFileSync(f, 'utf-8');
    writeFileSync(f, html.replace('</head>', `${script}</head>`));
  }

  console.log(`postbuild: Injected ${allRoutes.length} routes for preloading`);
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

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

// ────────────────────────────────────────────
// Main
// ────────────────────────────────────────────

restoreBlogRoutes();

if (existsSync(BUILD_DIR)) {
  await woff2.init();
  const htmlFiles = findHtmlFiles(BUILD_DIR);

  console.log(`postbuild: Processing ${htmlFiles.length} HTML files...`);
  for (const f of htmlFiles) {
    injectCriticalFonts(f);
  }

  injectRouteList(htmlFiles);
  console.log('postbuild: Done');
} else {
  console.log('postbuild: No build directory found, skipping');
}
