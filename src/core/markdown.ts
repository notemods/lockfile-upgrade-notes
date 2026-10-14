// Small Markdown helpers shared by every TS product. No host imports.

export interface LineInfo {
	/** Zero-based line index in the source text. */
	index: number;
	text: string;
	/** True for lines inside YAML frontmatter or a fenced code block (fence lines included). */
	inCode: boolean;
	inFrontmatter: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits text into lines (keeps "\r" out of the text) and marks frontmatter and fenced code. */
export function scanLines(text: string): LineInfo[] {
	const raw = text.split('\n');
	const out: LineInfo[] = [];
	let inFront = false;
	let fence: string | null = null;
	// Frontmatter only counts when it is closed; an unclosed "---" is a horizontal rule.
	const hasFrontmatter =
		(raw[0] ?? '').trim() === '---' && raw.slice(1).some((l) => l.trim() === '---' || l.trim() === '...');
	for (let i = 0; i < raw.length; i++) {
		const line = (raw[i] ?? '').replace(/\r$/, '');
		if (i === 0 && hasFrontmatter) {
			inFront = true;
			out.push({ index: i, text: line, inCode: false, inFrontmatter: true });
			continue;
		}
		if (inFront) {
			out.push({ index: i, text: line, inCode: false, inFrontmatter: true });
			if (line.trim() === '---' || line.trim() === '...') inFront = false;
			continue;
		}
		const m = FENCE.exec(line);
		if (fence === null && m && m[1]) {
			fence = m[1];
			out.push({ index: i, text: line, inCode: true, inFrontmatter: false });
			continue;
		}
		if (fence !== null) {
			out.push({ index: i, text: line, inCode: true, inFrontmatter: false });
			const close = FENCE.exec(line);
			if (close && close[1] && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) {
				fence = null;
			}
			continue;
		}
		out.push({ index: i, text: line, inCode: false, inFrontmatter: false });
	}
	return out;
}

/** Parses a comma or newline separated list, trims items and drops empties and duplicates. */
export function parseList(input: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of input.split(/[,\n]/)) {
		const item = part.trim();
		if (item && !seen.has(item.toLowerCase())) {
			seen.add(item.toLowerCase());
			out.push(item);
		}
	}
	return out;
}

/** Clamps a number into [min, max]; returns fallback for NaN or non-numbers. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}
