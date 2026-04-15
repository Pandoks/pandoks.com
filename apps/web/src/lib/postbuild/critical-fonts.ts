import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import subsetFont from 'subset-font';
import { parse } from 'node-html-parser';

const WEB_DIR = process.cwd();
const BUILD_DIR = join(WEB_DIR, 'build');
const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');

interface PageFonts {
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

function collectFontData(html: string): PageFonts {
	const data: PageFonts = {
		inter: new Set(),
		interItalic: new Set(),
		garamond: new Set(),
		garamondItalic: new Set()
	};

	const root = parse(html);
	const body = root.querySelector('body');
	if (!body) return data;

	for (const el of body.querySelectorAll('.font-garamond')) {
		addChars(data.garamond, el.textContent);
	}

	for (const el of body.querySelectorAll('.font-garamond .italic')) {
		addChars(data.garamondItalic, el.textContent);
	}

	const interClone = parse(body.outerHTML);
	for (const el of interClone.querySelectorAll('.font-garamond, .font-mono, script, style')) {
		el.remove();
	}
	addChars(data.inter, interClone.textContent);

	for (const el of body.querySelectorAll('.font-inter .italic')) {
		addChars(data.interItalic, el.textContent);
	}

	return data;
}

async function subsetToBase64(fontPath: string, chars: Set<string>): Promise<string | null> {
	if (chars.size === 0) return null;
	const text = [...chars].join('');
	const fontBuffer = readFileSync(fontPath);
	const output = await subsetFont(fontBuffer, text, { targetFormat: 'woff2' });
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

		const fontFaces: string[] = [];
		// cssWeight must match the external CSS @font-face weight range — Chrome
		// won't use an inline font with a narrower range than an existing CSS rule.
		// cssWeight must match the external CSS @font-face weight range — Chrome
		// won't use an inline font with a narrower range than an existing CSS rule.
		const fonts = [
			{ chars: data.inter, file: 'Inter.woff2', family: 'Inter', style: 'normal', cssWeight: '100 900' },
			{ chars: data.interItalic, file: 'Inter-Italic.woff2', family: 'Inter', style: 'italic', cssWeight: '100 900' },
			{ chars: data.garamond, file: 'EBGaramond.woff2', family: 'EB Garamond', style: 'normal', cssWeight: '400 800' },
			{ chars: data.garamondItalic, file: 'EBGaramond-Italic.woff2', family: 'EB Garamond', style: 'italic', cssWeight: '400 800' }
		];

		for (const { chars, file, family, style, cssWeight } of fonts) {
			if (chars.size === 0) continue;
			const b64 = await subsetToBase64(join(FONTS_DIR, file), chars);
			if (!b64) continue;
			const unicodeRange = unicodeRangeFromChars(chars);
			fontFaces.push(
				`@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2-variations');font-weight:${cssWeight};font-style:${style};font-display:block;unicode-range:${unicodeRange}}`
			);
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
	} catch (err) {
		const relativePath = htmlPath.replace(BUILD_DIR, '');
		console.error(`criticalFonts: Failed for ${relativePath}:`, err);
	}
}
