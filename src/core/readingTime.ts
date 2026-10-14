import { scanLines } from './markdown.js';

export interface ReadingOptions {
	/** Words per minute for space-separated scripts. Default 200. */
	wordsPerMinute?: number;
	/** Characters per minute for Chinese and Japanese text. Default 500. */
	cjkCharsPerMinute?: number;
	/** Count words inside fenced code blocks. Default false. */
	includeCode?: boolean;
}

export interface ReadingResult {
	words: number;
	cjkChars: number;
	/** Whole seconds, rounded up. */
	seconds: number;
	/** Whole minutes, rounded up; 0 only for empty text. */
	minutes: number;
	/** Short label such as "4 min read", "Under 1 min read" or "1 h 5 min read". */
	label: string;
}

export const READING_DEFAULTS: Required<ReadingOptions> = {
	wordsPerMinute: 200,
	cjkCharsPerMinute: 500,
	includeCode: false,
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;

/** Turns Markdown into the prose a reader actually reads. */
export function readableText(markdown: string, includeCode = false): string {
	const kept: string[] = [];
	for (const line of scanLines(markdown)) {
		if (line.inFrontmatter) continue;
		if (line.inCode) {
			if (includeCode && !/^ {0,3}(`{3,}|~{3,})/.test(line.text)) kept.push(line.text);
			continue;
		}
		kept.push(line.text);
	}
	let t = kept.join('\n');
	t = t.replace(/<!--[\s\S]*?-->/g, ' ');
	t = t.replace(/%%[\s\S]*?%%/g, ' ');
	t = t.replace(/!\[\[[^\]]*\]\]/g, ' ');
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
	t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
	t = t.replace(/\[\[([^\]]*)\]\]/g, (_m, target: string) => target.replace(/#\^?/g, ' '));
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	t = t.replace(/<https?:[^>]*>/g, ' ');
	t = t.replace(/https?:\/\/\S+/g, ' ');
	t = t.replace(/<[^>]+>/g, ' ');
	t = t.replace(/`([^`]*)`/g, includeCode ? '$1' : ' ');
	t = t.replace(/\[\^[^\]]*\]/g, ' ');
	t = t.replace(/(^|\s)\^[\w-]+(?=\s|$)/g, ' ');
	t = t.replace(/^\s*\d+[.)](?=\s)/gm, ' ');
	return t;
}

export function countWords(text: string): { words: number; cjkChars: number } {
	const cjkChars = (text.match(CJK) ?? []).length;
	const rest = text.replace(CJK, ' ');
	const words = (rest.match(WORD) ?? []).length;
	return { words, cjkChars };
}

export function formatReadingLabel(seconds: number): string {
	if (seconds <= 0) return '0 min read';
	if (seconds < 60) return 'Under 1 min read';
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes} min read`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return m === 0 ? `${h} h read` : `${h} h ${m} min read`;
}

export function readingTime(markdown: string, options: ReadingOptions = {}): ReadingResult {
	const wpm = positive(options.wordsPerMinute, READING_DEFAULTS.wordsPerMinute);
	const cpm = positive(options.cjkCharsPerMinute, READING_DEFAULTS.cjkCharsPerMinute);
	const includeCode = options.includeCode ?? READING_DEFAULTS.includeCode;
	const { words, cjkChars } = countWords(readableText(markdown, includeCode));
	const exact = (words / wpm + cjkChars / cpm) * 60;
	// Round to 6 decimals first so 400 words at 200 wpm is exactly 120 s, not 120.0000001.
	const seconds = Math.ceil(Math.round(exact * 1e6) / 1e6);
	return {
		words,
		cjkChars,
		seconds,
		minutes: Math.ceil(seconds / 60),
		label: formatReadingLabel(seconds),
	};
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
