export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
export const VERSION_ONLY = 'This report compares package versions only. Integrity and resolved fields are not compared.';
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export interface PackageEntry { version?: string; link?: boolean; name?: string }
export interface LockData { lockfileVersion: 2 | 3; packages: Record<string, PackageEntry>; direct: string[] }
export interface ChangeRow {
	path: string;
	name: string;
	status: 'added' | 'removed' | 'changed' | 'unsupported';
	oldVersion: string | null;
	newVersion: string | null;
	direct: boolean;
	label: 'major' | 'minor' | 'patch' | 'other' | null;
	downgrade: boolean;
	reason: string;
}
export interface Comparison { rows: ChangeRow[]; unchanged: number; oldFormat: number; newFormat: number }
export type CompareResult = { ok: true; comparison: Comparison } | { ok: false; error: string };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read only the fields used by the comparison. Keep incomplete entries visible. */
export function parseLock(text: string): LockData {
	if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('File exceeds 2 MiB.');
	let value: unknown;
	try { value = JSON.parse(text) as unknown; } catch { throw new Error('Parse error: input is not valid JSON.'); }
	if (!object(value) || (value.lockfileVersion !== 2 && value.lockfileVersion !== 3)) throw new Error('Unsupported format: use npm lockfile version 2 or 3.');
	if (!object(value.packages)) throw new Error('Unsupported format: packages must be an object.');
	const entries = Object.entries(value.packages);
	if (entries.length > MAX_ENTRIES) throw new Error('File exceeds 10,000 package entries.');
	const direct = new Set<string>();
	const root = value.packages[''];
	if (object(root)) {
		for (const group of GROUPS) {
			const dependencies = root[group];
			if (object(dependencies)) for (const name of Object.keys(dependencies)) direct.add(name);
		}
	}
	const packages: Record<string, PackageEntry> = Object.create(null) as Record<string, PackageEntry>;
	for (const [path, entry] of entries) {
		if (!path) continue;
		packages[path] = object(entry) ? {
			version: typeof entry.version === 'string' && entry.version.trim() !== '' ? entry.version : undefined,
			link: entry.link === true,
			name: typeof entry.name === 'string' ? entry.name : undefined,
		} : {};
	}
	return { lockfileVersion: value.lockfileVersion, packages, direct: [...direct].sort() };
}

/** Use the final installation segment. Keep a scoped name intact. */
export function packageName(path: string, entry?: PackageEntry): string {
	const rooted = `/${path}`;
	const marker = '/node_modules/';
	const index = rooted.lastIndexOf(marker);
	return index < 0 ? (entry?.name || path) : rooted.slice(index + marker.length);
}

function numeric(version: string): number[] | null {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
	const values = version.split('.').map(Number);
	return values.every(Number.isSafeInteger) ? values : null;
}

export function versionLabel(oldVersion: string, newVersion: string): { label: ChangeRow['label']; downgrade: boolean } {
	const a = numeric(oldVersion);
	const b = numeric(newVersion);
	if (!a || !b) return { label: 'other', downgrade: false };
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return { label: (['major', 'minor', 'patch'] as const)[i]!, downgrade: b[i]! < a[i]! };
	}
	return { label: 'other', downgrade: false };
}

export function compareLocks(oldLock: LockData, newLock: LockData): Comparison {
	const paths = [...new Set([...Object.keys(oldLock.packages), ...Object.keys(newLock.packages)])].sort();
	const direct = new Set([...oldLock.direct, ...newLock.direct]);
	const rows: ChangeRow[] = [];
	let unchanged = 0;
	for (const path of paths) {
		const a = oldLock.packages[path];
		const b = newLock.packages[path];
		const name = packageName(path, b ?? a);
		const row: ChangeRow = { path, name, status: 'changed', oldVersion: a?.version ?? null, newVersion: b?.version ?? null, direct: path === `node_modules/${name}` && direct.has(name), label: null, downgrade: false, reason: '' };
		const reasons: string[] = [];
		if (a?.link) reasons.push('Old entry is a link');
		else if (a && !a.version) reasons.push('Old entry has no version');
		if (b?.link) reasons.push('New entry is a link');
		else if (b && !b.version) reasons.push('New entry has no version');
		if (reasons.length) { row.status = 'unsupported'; row.reason = reasons.join('; '); }
		else if (!a) row.status = 'added';
		else if (!b) row.status = 'removed';
		else if (a.version === b.version) { unchanged++; continue; }
		else Object.assign(row, versionLabel(a.version!, b.version!));
		rows.push(row);
	}
	return { rows, unchanged, oldFormat: oldLock.lockfileVersion, newFormat: newLock.lockfileVersion };
}

/** Stable result shape for golden vectors and parse failures. */
export function compareSources(oldText: string, newText: string): CompareResult {
	try { return { ok: true, comparison: compareLocks(parseLock(oldText), parseLock(newText)) }; }
	catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** Baselines keep version data and direct names. They omit registry URLs and integrity values. */
export function snapshot(lock: LockData): string {
	return JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages: { '': { dependencies: Object.fromEntries(lock.direct.map((name) => [name, '*'])) }, ...lock.packages } });
}

export function cell(value: string | null): string {
	return (value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n]/g, ' ').replace(/([\\*_[\]])/g, '\\$1');
}

function sourceLink(path: string): string {
	return `[${cell(path)}](<${path.split('/').map(encodeURIComponent).join('/')}>)`;
}

export function renderReport(comparison: Comparison, oldPath: string, newPath: string, baseline?: { name: string; capturedAt: string }): string {
	const rows = comparison.rows;
	const count = (status: ChangeRow['status']) => rows.filter((r) => r.status === status).length;
	const lines = [
		'# Lockfile upgrade report', '',
		`Old source: ${sourceLink(oldPath)} (lockfile v${comparison.oldFormat}).`,
		`New source: ${sourceLink(newPath)} (lockfile v${comparison.newFormat}).`,
		...(baseline ? [`Old versions use local baseline ${cell(baseline.name)}, saved at ${cell(baseline.capturedAt)}. The old source link opens the current vault file, not the saved snapshot.`] : []),
		'', VERSION_ONLY,
		'Numeric major, minor and patch labels describe version numbers. They do not prove a breaking change or compatibility. Prerelease and non-numeric versions use other.',
		'Direct marks a root installation declared in the dependencies, devDependencies, optionalDependencies or peerDependencies of either source. Installation paths do not establish a dependency graph.', '',
		`${count('added')} added · ${count('removed')} removed · ${count('changed')} changed · ${count('unsupported')} unsupported or incomplete · ${comparison.unchanged} unchanged versions.`, '',
		'| Package | Installation path | Status | Old version | New version | Direct | Label | Detail |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |',
		...rows.map((r) => `| ${cell(r.name)} | ${cell(r.path)} | ${r.status} | ${cell(r.oldVersion)} | ${cell(r.newVersion)} | ${r.direct ? 'yes' : ''} | ${r.label ?? '—'} | ${cell(r.reason || (r.downgrade ? 'downgrade' : ''))} |`),
		...(rows.length ? [] : ['No added, removed or changed versions, or unsupported entries, were found.']), '',
	];
	return lines.join('\n');
}
