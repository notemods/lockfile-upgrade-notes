import { scanLines } from './markdown.js';

export interface MarkdownCsvTable { line: number; endLine: number; rows: string[][]; problem: string | null }
export interface TableCsvOptions { delimiter: ',' | ';' | '\t'; bom: boolean; headers: boolean }
export const TABLE_CSV_LIMIT = 2 * 1024 * 1024;

/** Pipe escapes become cell text. Other Markdown stays as source text. */
export function splitMarkdownCsvRow(line: string): string[] {
	const text = line.trim();
	const cells: string[] = [];
	let cell = '';
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\' && i + 1 < text.length) {
			if (text[i + 1] === '|') { cell += '|'; i++; continue; }
			cell += text[i]! + text[++i]!;
		} else if (text[i] === '|') { cells.push(cell.trim()); cell = ''; }
		else cell += text[i];
	}
	cells.push(cell.trim());
	if (text.startsWith('|')) cells.shift();
	if (cell === '' && cells[cells.length - 1] === '') cells.pop();
	return cells;
}

export function markdownCsvTables(source: string): MarkdownCsvTable[] {
	if (source.length > TABLE_CSV_LIMIT) throw new Error('The note exceeds 2,097,152 characters. Use a smaller note.');
	// Remove quote markers only in the parsing copy. Keep source line numbers.
	const lines = scanLines(source).map((line) => {
		let text = line.text;
		let depth = 0;
		for (let marker = /^ {0,3}>[ \t]?/.exec(text); marker; marker = /^ {0,3}>[ \t]?/.exec(text)) {
			text = text.slice(marker[0].length);
			depth++;
		}
		return { ...line, text, depth };
	});
	// Quoted fences need their own scan. A fence ends when its quote container ends.
	for (let start = 0; start < lines.length;) {
		let end = start + 1;
		while (end < lines.length && lines[end]!.depth === lines[start]!.depth) end++;
		if (lines[start]!.depth) {
			const quoted = scanLines('\n' + lines.slice(start, end).map((line) => line.text).join('\n'));
			for (let at = start; at < end; at++) lines[at]!.inCode ||= quoted[at - start + 1]!.inCode;
		}
		start = end;
	}
	const tables: MarkdownCsvTable[] = [];
	for (let i = 0; i + 1 < lines.length; i++) {
		const header = lines[i]!;
		const separator = lines[i + 1]!;
		if (header.depth !== separator.depth || header.inCode || header.inFrontmatter || separator.inCode || separator.inFrontmatter || !header.text.includes('|')) continue;
		const cells = splitMarkdownCsvRow(header.text);
		if (cells.length < 2 && !header.text.trim().startsWith('|')) continue;
		const rules = splitMarkdownCsvRow(separator.text);
		if (!cells.length || rules.length !== cells.length || !rules.every((c) => /^:?-{3,}:?$/.test(c))) continue;
		const table: MarkdownCsvTable = { line: i + 1, endLine: i + 2, rows: [cells], problem: null };
		let j = i + 2;
		for (; j < lines.length; j++) {
			const row = lines[j]!;
			if (row.depth !== header.depth || row.inCode || row.inFrontmatter || !row.text.trim() || /^(?: {4}|\t| {0,3}#{1,6}\s| {0,3}(?:[-+*]|\d+[.)])\s| {0,3}<)/.test(row.text)) break;
			const values = splitMarkdownCsvRow(row.text);
			if (values.length !== cells.length) table.problem ??= `Line ${j + 1} has ${values.length} cells. The header has ${cells.length}. Correct the row before export.`;
			table.rows.push(values);
			table.endLine = j + 1;
		}
		tables.push(table);
		i = j - 1;
	}
	return tables;
}

/** RFC 4180 quoting, with the selected delimiter. A BOM is an explicit file option. */
export function encodeTableCsv(rows: readonly (readonly string[])[], options: TableCsvOptions): string {
	const records = options.headers ? rows : rows.slice(1);
	const quote = (cell: string): string => cell.includes(options.delimiter) || /["\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
	return (options.bom ? '\uFEFF' : '') + records.map((row) => row.map(quote).join(options.delimiter)).join('\r\n') + (records.length ? '\r\n' : '');
}

export function csvFileStem(value: string): string {
	const cleaned = value.normalize('NFC').replace(/\.csv$/i, '').replace(/[\p{Cc}/\\:*?"<>|]/gu, '_').replace(/^[. ]+|[. ]+$/g, '');
	let stem = '';
	let bytes = 0;
	for (const character of cleaned) {
		const code = character.codePointAt(0)!;
		const length = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + length > 180) break;
		stem += character; bytes += length;
	}
	if (!stem || stem === '.' || stem === '..') throw new Error('Enter a file name.');
	return stem;
}
