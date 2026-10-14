import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';
import type LockfileUpgradeNotesPlugin from '../../src/main';

describe(`${pluginId} in Obsidian`, function () {
	before(async function () {
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id];
			return !!p && !!app.vault.getAbstractFileByPath('Old/package-lock.json') && !!app.vault.getAbstractFileByPath('New/package-lock.json');
		}, pluginId), { timeout: 30000, timeoutMsg: 'Plugin and sample files did not load' });
	});
	it('reloads without captured errors', async function () { expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] }); });
	it('opens file selectors, compares versions and creates the report through the UI', async function () {
		await browser.executeObsidianCommand(`${pluginId}:compare-lockfiles`);
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.lun-modal [data-lun-field="oldPath"]') !== null), { timeout: 10000 });
		for (const [field, path] of [['oldPath', 'Old/package-lock.json'], ['newPath', 'New/package-lock.json']]) {
			await browser.execute((field, path) => {
				const select = document.querySelector(`[data-lun-field="${field}"]`) as HTMLSelectElement;
				select.value = path!; select.dispatchEvent(new Event('change', { bubbles: true }));
			}, field, path);
		}
		await browser.execute(() => (document.querySelector('[data-lun-action="Compare versions"]') as HTMLButtonElement).click());
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.lun-summary')?.textContent?.includes('6 changed') === true), { timeout: 10000, timeoutMsg: 'Expected six changed package versions in the preview' });
		const paths = await browser.execute(() => Array.from(document.querySelectorAll('[data-lun-path]')).map((e) => e.getAttribute('data-lun-path')));
		expect(paths).toContain('node_modules/a'); expect(paths).toContain('node_modules/b/node_modules/a'); expect(paths).toContain('node_modules/@scope/ui');
		await browser.execute(() => (document.querySelector('[data-lun-action="Create report"]') as HTMLButtonElement).click());
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path === 'Lockfile upgrade report.md'), { timeout: 10000, timeoutMsg: 'Report did not open' });
		const report = await obsidianPage.read('Lockfile upgrade report.md');
		expect(report).toContain('versions only'); expect(report).toContain('downgrade'); expect(report).toContain('unsupported');
		expect(report).toContain('[Old/package-lock.json]'); expect(report).toContain('[New/package-lock.json]');
	});
	it('keeps source contents and adds a number to an existing report path without registry access', async function () {
		const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!;
			const old = app.vault.getFileByPath('Old/package-lock.json')!; const next = app.vault.getFileByPath('New/package-lock.json')!;
			const before = [await app.vault.read(old), await app.vault.read(next)];
			const requests: unknown[] = [];
			p.pro!.signOut(); p.pro!.opts.http = async (request) => { requests.push(request); throw new Error('Network disabled'); };
			const file = await p.createReport(await p.compare(old.path, next.path));
			return { path: file.path, before, after: [await app.vault.read(old), await app.vault.read(next)], requests: requests.length };
		}, pluginId);
		expect(result.path).toBe('Lockfile upgrade report 2.md'); expect(result.after).toEqual(result.before); expect(result.requests).toBe(0);
	});
	it('shows an invalid JSON error and does not create a report', async function () {
		await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!;
			p.openCompare('Invalid.json', 'New/package-lock.json');
		}, pluginId);
		await browser.execute(() => (document.querySelector('[data-lun-action="Compare versions"]') as HTMLButtonElement).click());
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.lun-error')?.textContent?.includes('Parse error') === true), { timeout: 10000 });
		expect(await browser.execute(() => (document.querySelector('[data-lun-action="Create report"]') as HTMLButtonElement).disabled)).toBe(true);
		await browser.executeObsidian(({ app }, id) => { const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!; p.onunload(); }, pluginId);
	});
	it('rejects v1 and keeps the free comparison available when Pro is off', async function () {
		expect((await reloadPlugin(pluginId)).errors).toEqual([]);
		const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!; p.pro!.signOut();
			const errors: string[] = [];
			for (const task of [() => p.compare('Version1.json', 'New/package-lock.json'), () => p.savePair('Atlas', 'Old/package-lock.json', 'New/package-lock.json'), () => p.saveBaseline('Atlas', 'New/package-lock.json')]) {
				try { await task(); } catch (e) { errors.push(String(e)); }
			}
			return { errors, rows: (await p.compare('Old/package-lock.json', 'New/package-lock.json')).comparison.rows.length, pairs: p.settings.pairs.length, baselines: p.settings.baselines.length };
		}, pluginId);
		expect(result.errors[0]).toContain('Unsupported format'); expect(result.errors[1]).toContain('Pro'); expect(result.errors[2]).toContain('Pro');
		expect(result.rows).toBe(10); expect(result.pairs).toBe(0); expect(result.baselines).toBe(0);
	});
	it('saves a pair and a local baseline with a stub sponsorship, then loads them after reload', async function () {
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!;
			p.pro!.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
			app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36)); await p.pro!.refreshNow();
			await p.savePair('Atlas', 'Old/package-lock.json', 'New/package-lock.json'); await p.saveBaseline('Atlas', 'Old/package-lock.json');
		}, pluginId);
		expect((await reloadPlugin(pluginId)).errors).toEqual([]);
		const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!;
			const pair = p.loadPair('Atlas'); const baseline = await p.compareBaseline('Atlas', 'New/package-lock.json');
			const file = await p.createReport(baseline); const text = await app.vault.read(file);
			p.pro!.signOut(); await p.removeSaved('pair', 'Atlas'); await p.removeSaved('baseline', 'Atlas');
			return { pair, rows: baseline.comparison.rows.length, text };
		}, pluginId);
		expect(result.pair).toEqual({ name: 'Atlas', oldPath: 'Old/package-lock.json', newPath: 'New/package-lock.json' });
		expect(result.rows).toBe(10); expect(result.text).toContain('local baseline Atlas'); expect(result.text).toContain('not the saved snapshot');
	});
});
