/** Basic Zim conversion. No vault or network access. */
export interface ZimSource { path: string; text: string }
export interface ZimRules { folders: 'tree' | 'flat'; names: 'spaces' | 'hyphens' }
export interface ZimIssue { source: string; line: number; kind: string; detail: string }
export interface ZimNote { source: string; path: string; body: string; properties: Record<string, string> }
export interface ZimPlan { notes: ZimNote[]; issues: ZimIssue[]; conflicts: string[] }
export const ZIM_RULES: ZimRules = { folders: 'tree', names: 'spaces' };
const key = (s: string) => s.normalize('NFC').toLowerCase();
export function validZimPath(path: string): boolean {
	return path.length > 0 && path.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && !/[\\:*?"<>|#[\]]/.test(p) && ![...p].some((c) => c.charCodeAt(0) < 32) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p));
}
/** Zim checkbox bullets and the task status that each one becomes. Zim `[x]` means dismissed, so it does not become a done task. */
const CHECKBOX: Record<string, string> = { ' ': ' ', '*': 'x', x: 'c', '>': '>', '<': '<' };
const UNSUPPORTED = /\{\{|^\s*\||__|~~|\[\s*[x* ><]\s*\]|\[\s*\]|^\s*\{\{\{|^\s*```|<\/?[a-z][^>]*>|\$\$/;
function pageName(path: string): string { return path.replace(/\.txt$/i, '').replace(/_/g, ' ').normalize('NFC'); }
function safeName(s: string, rules: ZimRules): string {
	let out = [...s.replace(/[\u00a0\u202f]/g, ' ')].map((c) => c.charCodeAt(0) < 32 ? '-' : c).join('').replace(/[\\:*?"<>|#[\]]/g, '-').trim().replace(/[. ]+$/g, '');
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) out = '_' + out;
	if (rules.names === 'hyphens') out = out.replace(/ /g, '-');
	return out || 'Untitled';
}
/** Page lookup tables, built once for each plan. */
interface ZimLinkIndex { pages: Set<string>; tree: Set<string>; byKey: Map<string, string[]> }
function linkIndex(pages: string[]): ZimLinkIndex {
	const tree = new Set<string>();
	for (const page of pages) {
		const parts = page.split('/');
		for (let n = 1; n <= parts.length; n++) tree.add(parts.slice(0, n).join('/'));
	}
	const byKey = new Map<string, string[]>();
	for (const p of tree) { const k = key(p); const list = byKey.get(k); if (list) list.push(p); else byKey.set(k, [p]); }
	return { pages: new Set(pages), tree, byKey };
}
/** Resolve the first link component in the nearest shared namespace, then its children.
 * Unlike Zim's arbitrary fallback, ambiguous case variants remain unresolved. */
export function resolveZimLink(current: string, link: string, pages: string[]): string | null {
	return resolveIndexed(current, link, linkIndex(pages));
}
function resolveIndexed(current: string, link: string, { pages, tree, byKey }: ZimLinkIndex): string | null {
	link = link.trim().replace(/_/g, ' ').normalize('NFC');
	if (!link || /[/?#\\]/.test(link) || /^[a-z][a-z\d+.-]*:\/\//i.test(link)) return null;
	const components = link.replace(/^[:+]/, '').split(':');
	if (components.some((p) => !p.trim() || p === '.' || p === '..')) return null;
	const child = (parent: string, part: string): string | null => {
		const candidate = (parent ? parent + '/' : '') + part;
		if (tree.has(candidate)) return candidate;
		const matches = byKey.get(key(candidate)) ?? [];
		return matches.length === 1 ? matches[0]! : null;
	};
	let anchor: string | null = null;
	if (link.startsWith(':')) anchor = child('', components.shift()!);
	else if (link.startsWith('+')) anchor = child(current, components.shift()!);
	else {
		const part = components.shift()!;
		const parent = current.split('/').slice(0, -1);
		for (let n = parent.length; n >= 0; n--) {
			const namespace = parent.slice(0, n).join('/');
			const candidate = (namespace ? namespace + '/' : '') + part;
			if (byKey.has(key(candidate))) { anchor = child(namespace, part); break; }
		}
	}
	if (anchor === null) return null;
	for (const part of components) { anchor = child(anchor, part); if (anchor === null) return null; }
	return pages.has(anchor) ? anchor : null;
}
function convert(source: ZimSource, page: string, paths: Map<string, string>, index: ZimLinkIndex, issues: ZimIssue[]): { body: string; properties: Record<string, string> } {
	const properties: Record<string, string> = { zim_source: source.path };
	const lines = source.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
	const report = (i: number, kind: string, detail: string) => issues.push({ source: source.path, line: i + 1, kind, detail });
	let start = 0;
	const unknownHeaders: string[] = [];
	if (lines[0]?.startsWith('Content-Type:')) {
		const end = lines.indexOf('');
		// Zim reads formats 0.4 to 0.6 with the same basic syntax. Zim 0.66 and later write 0.6.
		if (end >= 0 && lines[0] === 'Content-Type: text/x-zim-wiki' && lines.slice(0, end).some((h) => /^Wiki-Format: zim 0\.[456]$/.test(h))) {
			for (const [index, header] of lines.slice(0, end).entries()) {
				const date = /^Creation-Date:\s*(.+)$/.exec(header);
				if (date) properties.zim_created = date[1]!;
				else if (!/^(Content-Type|Wiki-Format):/.test(header)) { report(index, 'header', header); unknownHeaders.push(header); }
			}
			start = end + 1;
		} else {
			report(0, 'format', 'Unsupported or incomplete Zim header; page retained verbatim.');
			return { body: source.text, properties };
		}
	}
	const out: string[] = unknownHeaders.length ? [...unknownHeaders, ''] : [];
	let objectBlock = false;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]!;
		if (objectBlock || /^\s*\{\{\{/.test(line)) {
			if (!objectBlock) report(i, 'syntax', 'Unsupported object block retained verbatim');
			objectBlock = !/^\s*\}\}\}\s*$/.test(line);
			out.push(line); continue;
		}
		if (/^\s*'''\s*$/.test(line)) {
			let end = i + 1;
			while (end < lines.length && !/^\s*'''\s*$/.test(lines[end]!)) end++;
			if (end === lines.length) { report(i, 'code', 'Unclosed code block'); for (const rest of lines.slice(i)) out.push(rest); break; }
			const code = lines.slice(i + 1, end);
			let longest = 2;
			for (const codeLine of code) for (const match of codeLine.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
			const fence = '`'.repeat(longest + 1);
			out.push(fence);
			for (const codeLine of code) out.push(codeLine);
			out.push(fence); i = end; continue;
		}
		// A Zim checkbox starts the line after tab indentation and needs a space or tab after it.
		const box = /^(\t*)\[([ *x<>])\][ \t]+(.*)$/.exec(line);
		const content = box ? box[3]! : line;
		if (UNSUPPORTED.test(content)) {
			report(i, 'syntax', line); out.push(line); continue;
		}
		const heading = box ? null : /^(={2,6})\s+(.+?)\s+\1\s*$/.exec(line);
		let text = heading ? '#'.repeat(7 - heading[1]!.length) + ' ' + heading[2]! : content;
		const protectedText: string[] = [];
		let marker = String.fromCharCode(0);
		while (content.includes(marker)) marker += String.fromCharCode(0);
		const keep = (s: string) => { protectedText.push(s); return `${marker}${protectedText.length - 1}${marker}`; };
		// Read code spans and links in one pass so their contents cannot become nested placeholders.
		text = text.replace(/''([^']+?)''|\[\[([^\]]+)\]\]/g, (whole: string, code: string | undefined, inside: string | undefined) => {
			if (code !== undefined) {
				let longest = 0;
				for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
				const fence = '`'.repeat(longest + 1);
				return keep(`${fence} ${code} ${fence}`);
			}
			const [target, ...labels] = inside!.split('|');
			const found = resolveIndexed(page, target!, index);
			if (found === null) { report(i, 'link', whole); return keep(whole); }
			return keep(`[[${paths.get(found)!.replace(/\.md$/, '')}${labels.length ? '|' + labels.join('|') : ''}]]`);
		});
		text = text.replace(/(^|[\s(])\/\/(\S(?:.*?\S)?)\/\//g, '$1*$2*');
		text = text.replace(new RegExp(marker + '(\\d+)' + marker, 'g'), (_, n: string) => protectedText[Number(n)]!);
		out.push(box ? `${box[1]}- [${CHECKBOX[box[2]!]}] ${text}`.trimEnd() : text);
	}
	return { body: out.join('\n'), properties };
}
/** Plan the full import before a vault write. Conflicts block the full batch. */
export function planZimImport(sources: ZimSource[], sourceFolder: string, destination: string, existing: string[] = [], rules: ZimRules = ZIM_RULES): ZimPlan {
	const plan: ZimPlan = { notes: [], issues: [], conflicts: [] };
	if (!validZimPath(sourceFolder) || !validZimPath(destination)) { plan.conflicts.push('Source and destination must be valid vault folders.'); return plan; }
	if (key(sourceFolder) === key(destination) || key(destination).startsWith(key(sourceFolder) + '/') || key(sourceFolder).startsWith(key(destination) + '/')) {
		plan.conflicts.push('Source and destination folders must be separate.'); return plan;
	}
	const existingKeys = new Set(existing.map(key));
	if ([...existingKeys].some((p) => p === key(destination) || p.startsWith(key(destination) + '/'))) plan.conflicts.push(`Destination exists: ${destination}`);
	const paths = new Map<string, string>();
	const pages: { source: ZimSource; page: string; path: string }[] = [];
	const used = new Map<string, string>();
	for (const source of [...sources].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
		if (!source.path.startsWith(sourceFolder + '/')) continue;
		if (!/\.txt$/i.test(source.path)) { plan.issues.push({ source: source.path, line: 0, kind: 'extension', detail: 'Source file retained; this extension is not converted.' }); continue; }
		const page = pageName(source.path.slice(sourceFolder.length + 1));
		const parts = page.split('/');
		const names = (rules.folders === 'flat' ? [parts[parts.length - 1]!] : parts).map((s) => safeName(s, rules));
		const path = destination + '/' + names.join('/') + '.md';
		const prior = used.get(key(path));
		if (prior) plan.conflicts.push(`Output collision: ${prior} and ${source.path} -> ${path}`);
		used.set(key(path), source.path);
		if (paths.has(page)) plan.conflicts.push(`Page name collision: ${page} (${source.path})`);
		paths.set(page, path); pages.push({ source, page, path });
		if (existingKeys.has(key(path))) plan.conflicts.push(`Existing path: ${path} (${source.path})`);
	}
	const folders = new Map<string, { path: string; source: string }>();
	for (const item of pages) {
		const parts = item.path.split('/');
		for (let n = 1; n < parts.length; n++) {
			const parent = parts.slice(0, n).join('/');
			const prior = folders.get(key(parent));
			if (prior && prior.path !== parent) plan.conflicts.push(`Folder case collision: ${prior.source} and ${item.source.path} -> ${parent}`);
			else folders.set(key(parent), { path: parent, source: item.source.path });
			const blocking = used.get(key(parent));
			if (blocking) plan.conflicts.push(`File and folder collision: ${blocking} and ${item.source.path} -> ${parent}`);
		}
	}
	const index = linkIndex([...paths.keys()]);
	for (const item of pages) {
		const converted = convert(item.source, item.page, paths, index, plan.issues);
		plan.notes.push({ source: item.source.path, path: item.path, ...converted });
	}
	if (!pages.length) plan.conflicts.push('No .txt pages in the source folder.');
	return plan;
}
export function compareZimSources(previous: ZimSource[], current: ZimSource[]): { added: string[]; changed: string[]; removed: string[]; unchanged: number } {
	const before = new Map(previous.filter((s) => /\.txt$/i.test(s.path)).map((s) => [s.path, s.text]));
	const after = new Map(current.filter((s) => /\.txt$/i.test(s.path)).map((s) => [s.path, s.text]));
	return {
		added: [...after.keys()].filter((p) => !before.has(p)).sort(),
		changed: [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p)).sort(),
		removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
		unchanged: [...after.keys()].filter((p) => before.get(p) === after.get(p)).length,
	};
}
