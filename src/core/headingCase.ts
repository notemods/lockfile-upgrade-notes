import { scanLines } from './markdown.js';

export type HeadingCaseMode = 'sentence' | 'title';

export interface HeadingCaseOptions {
	mode: HeadingCaseMode;
	/** Words or phrases that keep the exact spelling given here (names, brands, product terms). */
	keep?: string[];
	/** Only convert headings on lines fromLine..toLine (zero-based, inclusive). */
	fromLine?: number;
	toLine?: number;
}

export interface HeadingChange {
	line: number;
	before: string;
	after: string;
}

export interface HeadingCaseResult {
	text: string;
	headings: number;
	changes: HeadingChange[];
}

/**
 * Lowercase in title case unless first, last or after a colon (AP and Chicago agree on these).
 * "up" and "off" are left out on purpose: in headings they are almost always verb particles
 * ("Setting Up", "Kick Off") and both styles capitalize particles.
 */
export const TITLE_SMALL_WORDS: readonly string[] = [
	'a', 'an', 'and', 'as', 'at', 'but', 'by', 'en', 'for', 'if', 'in', 'nor', 'of',
	'on', 'or', 'per', 'so', 'the', 'to', 'via', 'vs', 'yet',
];
const SMALL = new Set(TITLE_SMALL_WORDS);

const ATX = /^( {0,3}#{1,6})([ \t]+)(.*?)(?:([ \t]+#+)[ \t]*)?$/;

// Parts of a heading that are never re-cased: inline code, wikilinks, link targets, HTML,
// bare URLs, footnotes, inline math, tags and a trailing block id.
const PROTECT = new RegExp(
	[
		'`[^`]*`',
		'\\[\\[[^\\]]*\\]\\]',
		'\\]\\([^)]*\\)',
		'<[^>]+>',
		'https?://\\S+',
		'\\[\\^[^\\]]*\\]',
		'\\$[^$\\s](?:[^$]*[^$\\s])?\\$',
		// No lookbehind: Obsidian mobile on iOS before 16.4 cannot parse it (obsidianmd/regex-lookbehind).
		'(?:^|\\s)#[\\p{L}\\p{N}_/-]+',
		'\\s\\^[\\w-]+$',
	].join('|'),
	'gu',
);

interface Token {
	start: number;
	end: number;
	prefix: string;
	core: string;
	suffix: string;
	keep?: string;
}

interface Item {
	start: number;
	end: number;
	token?: Token;
	raw: string;
}

const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

function splitToken(raw: string, start: number): Token {
	const pre = /^[^\p{L}\p{N}]*/u.exec(raw)?.[0] ?? '';
	const rest = raw.slice(pre.length);
	const suf = /[^\p{L}\p{N}]*$/u.exec(rest)?.[0] ?? '';
	return { start, end: start + raw.length, prefix: pre, core: rest.slice(0, rest.length - suf.length), suffix: suf };
}

function capFirst(s: string): string {
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] ?? '';
		if (LETTER.test(ch)) return s.slice(0, i) + ch.toUpperCase() + s.slice(i + 1);
	}
	return s;
}

/** A part keeps its spelling when it mixes case (iPhone, JavaScript), is an acronym (API) or has a digit (3D). */
function isFixed(part: string, shouting: boolean): boolean {
	if (/\p{N}/u.test(part)) return true;
	const letters = [...part].filter((c) => LETTER.test(c));
	if (letters.length === 0) return true;
	if (!shouting && letters.length >= 2 && !letters.some((c) => LOWER.test(c))) return true;
	if (!shouting && letters.slice(1).some((c) => UPPER.test(c)) && letters.some((c) => LOWER.test(c))) return true;
	return false;
}

function recaseCore(core: string, mode: HeadingCaseMode, position: 'start' | 'middle' | 'last', shouting: boolean): string {
	if (/^i(['’](m|ve|ll|d))?$/i.test(core)) return 'I' + core.slice(1).toLowerCase();
	const parts = core.split('-');
	return parts
		.map((part, i) => {
			if (isFixed(part, shouting)) return part;
			const lower = part.toLowerCase();
			if (mode === 'sentence') {
				return position === 'start' && i === 0 ? capFirst(lower) : lower;
			}
			// Title case: small words stay lower unless they open or close the heading,
			// follow a colon, or open a hyphenated compound ("In-Depth").
			const forced =
				(position === 'start' && i === 0) ||
				(position === 'last' && i === parts.length - 1) ||
				(i === 0 && parts.length > 1);
			return SMALL.has(lower) && !forced ? lower : capFirst(lower);
		})
		.join('-');
}

function markKeep(tokens: Token[], keep: string[]): void {
	const phrases = keep
		.map((k) => k.trim().split(/\s+/).filter(Boolean))
		.filter((p) => p.length > 0)
		.sort((a, b) => b.length - a.length);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i]?.keep !== undefined) continue;
		for (const phrase of phrases) {
			if (i + phrase.length > tokens.length) continue;
			let ok = true;
			for (let j = 0; j < phrase.length; j++) {
				const t = tokens[i + j];
				const w = splitToken(phrase[j] ?? '', 0).core;
				if (!t || t.keep !== undefined || t.core.toLowerCase() !== w.toLowerCase()) {
					ok = false;
					break;
				}
			}
			if (!ok) continue;
			for (let j = 0; j < phrase.length; j++) {
				const t = tokens[i + j];
				if (t) t.keep = splitToken(phrase[j] ?? '', 0).core;
			}
			break;
		}
	}
}

/** Re-cases the text of one heading (without the leading #). */
export function convertHeadingText(text: string, mode: HeadingCaseMode, keep: string[] = []): string {
	const items: Item[] = [];
	let last = 0;
	const free: Array<{ start: number; text: string }> = [];
	PROTECT.lastIndex = 0;
	for (let m = PROTECT.exec(text); m !== null; m = PROTECT.exec(text)) {
		if (m[0].length === 0) {
			PROTECT.lastIndex++;
			continue;
		}
		if (m.index > last) free.push({ start: last, text: text.slice(last, m.index) });
		// A link target "](url)" belongs to the link text before it, so it is not a separate word.
		if (!m[0].startsWith('](')) items.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
		last = m.index + m[0].length;
	}
	if (last < text.length) free.push({ start: last, text: text.slice(last) });

	const tokens: Token[] = [];
	for (const seg of free) {
		const re = /\S+/g;
		for (let m = re.exec(seg.text); m !== null; m = re.exec(seg.text)) {
			const t = splitToken(m[0], seg.start + m.index);
			if (t.core.length > 0) {
				tokens.push(t);
				items.push({ start: t.start, end: t.end, raw: m[0], token: t });
			}
		}
	}
	if (tokens.length === 0) return text;
	items.sort((a, b) => a.start - b.start);

	const freeText = free.map((f) => f.text).join(' ');
	const shouting = !LOWER.test(freeText) && tokens.some((t) => [...t.core].filter((c) => LETTER.test(c)).length >= 2);
	markKeep(tokens, keep);

	const replaced = new Map<Token, string>();
	items.forEach((item, idx) => {
		const t = item.token;
		if (!t) return;
		if (t.keep !== undefined) {
			replaced.set(t, t.keep);
			return;
		}
		const prev = idx > 0 ? items[idx - 1] : undefined;
		const afterBreak = prev !== undefined && /[:?!]["'”’*_)\]]*$/.test(prev.raw);
		const position = idx === 0 || afterBreak ? 'start' : idx === items.length - 1 ? 'last' : 'middle';
		replaced.set(t, recaseCore(t.core, mode, position, shouting));
	});

	let out = '';
	let pos = 0;
	for (const t of tokens) {
		out += text.slice(pos, t.start) + t.prefix + (replaced.get(t) ?? t.core) + t.suffix;
		pos = t.end;
	}
	return out + text.slice(pos);
}

/** Converts every ATX heading outside frontmatter and code blocks. */
export function convertHeadings(markdown: string, options: HeadingCaseOptions): HeadingCaseResult {
	const keep = options.keep ?? [];
	const from = options.fromLine ?? 0;
	const to = options.toLine ?? Number.MAX_SAFE_INTEGER;
	const raw = markdown.split('\n');
	const changes: HeadingChange[] = [];
	let headings = 0;
	for (const line of scanLines(markdown)) {
		if (line.inCode || line.inFrontmatter || line.index < from || line.index > to) continue;
		const m = ATX.exec(line.text);
		if (!m || !m[3]) continue;
		headings++;
		const after = (m[1] ?? '') + (m[2] ?? '') + convertHeadingText(m[3], options.mode, keep) + (m[4] ?? '');
		const tail = line.text.slice((m[1] ?? '').length + (m[2] ?? '').length + m[3].length + (m[4] ?? '').length);
		const next = after + tail;
		if (next !== line.text) {
			changes.push({ line: line.index, before: line.text, after: next });
			const cr = (raw[line.index] ?? '').endsWith('\r') ? '\r' : '';
			raw[line.index] = next + cr;
		}
	}
	return { text: raw.join('\n'), headings, changes };
}
