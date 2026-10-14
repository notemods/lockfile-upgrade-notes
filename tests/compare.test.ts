import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { compareSources, parseLock, compareLocks, renderReport, snapshot, packageName, MAX_BYTES, MAX_ENTRIES, VERSION_ONLY } from '../src/compare';
import vectors from './fixtures/vectors.json';

for (const c of vectors.cases) it(c.name, () => expect(compareSources(c.args[0]!, c.args[1]!)).toEqual(c.expected));

const monoVectors = '../../packages/spec/vectors/lockfile-upgrade-notes.json';
it.skipIf(!existsSync(monoVectors))('export fixture matches the factory vectors', () => {
	expect(JSON.parse(readFileSync(monoVectors, 'utf8'))).toEqual(vectors);
});

const lock = (packages: Record<string, unknown>, root: Record<string, unknown> = {}) => JSON.stringify({ lockfileVersion: 3, packages: { '': root, ...packages } });

describe('limits and snapshots', () => {
	it('counts UTF-8 bytes and accepts exactly 2 MiB', () => {
		const small = lock({});
		expect(() => parseLock(small + ' '.repeat(MAX_BYTES - small.length))).not.toThrow();
		expect(() => parseLock(small + ' '.repeat(MAX_BYTES - small.length + 1))).toThrow('2 MiB');
		expect(() => parseLock(lock({ a: { version: 'é'.repeat(MAX_BYTES / 2) } }))).toThrow('2 MiB');
	});
	it('counts the root entry in the 10,000-entry limit', () => {
		const entries = Object.fromEntries(Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]));
		expect(Object.keys(parseLock(lock(entries)).packages)).toHaveLength(MAX_ENTRIES - 1);
		entries.extra = { version: '1.0.0' };
		expect(() => parseLock(lock(entries))).toThrow('10,000');
	});
	it('omits registry and integrity fields from a baseline and preserves comparison data', () => {
		const input = parseLock(lock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.invalid/a', integrity: 'hash' }, 'node_modules/b': { link: true } }, { peerDependencies: { a: '*' } }));
		const text = snapshot(input);
		expect(text).not.toMatch(/resolved|integrity|registry/);
		expect(parseLock(text)).toEqual(input);
	});
	it('handles a package key named __proto__ without an inherited package', () => {
		const text = '{"lockfileVersion":3,"packages":{"__proto__":{"version":"1.0.0"}}}';
		expect(Object.keys(parseLock(text).packages)).toEqual(['__proto__']);
		expect(compareLocks(parseLock(lock({})), parseLock(text)).rows[0]?.path).toBe('__proto__');
	});
	it('keeps whitespace-only and non-string versions incomplete', () => {
		const result = compareSources(lock({ 'node_modules/a': { version: '  ' } }), lock({ 'node_modules/a': { version: 1 } }));
		expect(result.ok && result.comparison.rows[0]?.status).toBe('unsupported');
	});
	it('does not assign numeric labels to numbers above the safe integer range', () => {
		const result = compareSources(lock({ a: { version: '9007199254740992.0.0' } }), lock({ a: { version: '9007199254740993.0.0' } }));
		expect(result.ok && result.comparison.rows[0]?.label).toBe('other');
	});
});

describe('Markdown report', () => {
	const compared = compareLocks(parseLock(lock({ 'node_modules/a': { version: '2.3.4' } }, { dependencies: { a: '*' } })), parseLock(lock({ 'node_modules/a': { version: '1.9.0' } })));
	it('includes both source links, counts, the version-only scope and downgrade', () => {
		const report = renderReport(compared, 'Old/package-lock.json', 'New/package-lock.json');
		expect(report).toContain('[Old/package-lock.json](<Old/package-lock.json>)');
		expect(report).toContain('[New/package-lock.json](<New/package-lock.json>)');
		expect(report).toContain(VERSION_ONLY);
		expect(report).toContain('1 changed');
		expect(report).toContain('| yes | major | downgrade |');
	});
	it('escapes table content and source names without creating markup', () => {
		const evil = compareLocks(parseLock(lock({})), parseLock(lock({ 'node_modules/<script>|x': { version: '`bad`\nvalue' } })));
		const report = renderReport(evil, 'Old [#^|].json', 'New/x).json');
		expect(report).toContain('&lt;script&gt;&#124;x');
		expect(report).not.toContain('<script>');
		expect(report).toContain('&#96;bad&#96; value');
		expect(report).toContain('Old%20%5B%23%5E%7C%5D.json');
	});
	it('states that a baseline source link opens the current vault file', () => {
		expect(renderReport(compared, 'old.json', 'new.json', { name: 'Project', capturedAt: '2026-10-14T00:00:00Z' })).toContain('not the saved snapshot');
	});
	it('states the empty result without claiming incomplete packages are unchanged', () => {
		const empty = compareLocks(parseLock(lock({})), parseLock(lock({})));
		expect(renderReport(empty, 'old.json', 'new.json')).toContain('No added, removed or changed versions, or unsupported entries, were found.');
	});
	it('retains a non-installation path rather than inferring a graph', () => {
		expect(packageName('packages/lib', { name: 'lib' })).toBe('lib');
		expect(packageName('packages/lib')).toBe('packages/lib');
	});
});

describe('installation segment boundaries', () => {
	it('keeps a node_modules scope and its direct mark', () => {
		const path = 'node_modules/@node_modules/ui';
		const result = compareLocks(parseLock(lock({ [path]: { version: '1.0.0' } }, { dependencies: { '@node_modules/ui': '*' } })), parseLock(lock({ [path]: { version: '1.0.1' } })));
		expect(result.rows[0]).toMatchObject({ name: '@node_modules/ui', direct: true });
		expect(packageName('node_modules/a/node_modules/@node_modules/ui')).toBe('@node_modules/ui');
	});
	it('does not split a workspace folder that ends with node_modules', () => {
		expect(packageName('packages/my-node_modules/ui', { name: 'workspace-ui' })).toBe('workspace-ui');
	});
});

describe('complete report at the entry limit', () => {
	it('keeps all additions and removals from two disjoint package maps', () => {
		const entries = (prefix: string) => Object.fromEntries(Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => [`node_modules/${prefix}${i}`, { version: '1.0.0' }]));
		const comparison = compareLocks(parseLock(lock(entries('old'))), parseLock(lock(entries('new'))));
		expect(comparison.rows).toHaveLength(2 * (MAX_ENTRIES - 1));
		const report = renderReport(comparison, 'old.json', 'new.json');
		expect(report.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Package') && !line.startsWith('| ---'))).toHaveLength(comparison.rows.length);
		expect(report.includes('| new0 | node\\_modules/new0 | added |')).toBe(true);
		expect(report.includes('| old9998 | node\\_modules/old9998 | removed |')).toBe(true);
	});
});
