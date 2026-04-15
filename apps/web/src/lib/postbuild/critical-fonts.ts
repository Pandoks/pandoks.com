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
	// Pin to actual weights used on this page — the full variable font arrives
	// via <link rel="preload"> and handles other weights after first paint.
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

		const fontFaces: string[] = [];
		// cssWeight must match the external CSS @font-face weight range — Chrome
		// won't use an inline font with a narrower range than an existing CSS rule.
		const fonts = [
			{ data: data.inter, file: 'Inter.woff2', family: 'Inter', style: 'normal', cssWeight: '100 900' },
			{ data: data.interItalic, file: 'Inter-Italic.woff2', family: 'Inter', style: 'italic', cssWeight: '100 900' },
			{ data: data.garamond, file: 'EBGaramond.woff2', family: 'EB Garamond', style: 'normal', cssWeight: '400 800' },
			{ data: data.garamondItalic, file: 'EBGaramond-Italic.woff2', family: 'EB Garamond', style: 'italic', cssWeight: '400 800' }
		];

		for (const { data, file, family, style, cssWeight } of fonts) {
			if (data.chars.size === 0) continue;
			const weights = [...data.weights].sort((a, b) => a - b);
			const b64 = await subsetToBase64(join(FONTS_DIR, file), data.chars, weights);
			if (!b64) continue;
			const unicodeRange = unicodeRangeFromChars(data.chars);
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
