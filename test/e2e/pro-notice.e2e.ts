import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';
import type LockfileUpgradeNotesPlugin from '../../src/main';

// A free user opens the comparison from the command palette, chooses two lockfiles and selects "Save pair (Pro)".
// The shared Pro notice must show once, with a Sponsor on GitHub button that opens the Sponsors page with
// frequency=one-time and metadata_source=<plugin id>. No pair is saved.
const LEAD = 'Named pairs and project baselines are Pro features.';
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const SAVE = '.lun-modal [data-lun-action="Save pair (Pro)"]';

interface Shown { text: string; buttons: number }
async function notices(): Promise<Shown[]> {
	return browser.execute(() => [...(window as unknown as { activeWindow: Window }).activeWindow.document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })));
}

describe(`${pluginId} Pro notice`, function () {
	before(async function () {
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id];
			return !!p && !!app.vault.getAbstractFileByPath('Old/package-lock.json') && !!app.vault.getAbstractFileByPath('New/package-lock.json');
		}, pluginId), { timeout: 30000, timeoutMsg: 'Plugin and sample files did not load' });
	});

	it('shows the Sponsor on GitHub button when a free user selects Save pair (Pro)', async function () {
		await browser.executeObsidian(({ app }, id) => {
			(app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!.pro!.signOut();
			for (const doc of new Set([document, (window as unknown as { activeWindow: Window }).activeWindow.document])) doc.querySelectorAll('.notice').forEach((n) => n.remove());
		}, pluginId);
		await browser.executeObsidianCommand(`${pluginId}:compare-lockfiles`);
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.lun-modal [data-lun-field="oldPath"]') !== null), { timeout: 10000, timeoutMsg: 'The comparison dialog did not open.' });
		for (const [field, path] of [['oldPath', 'Old/package-lock.json'], ['newPath', 'New/package-lock.json']]) {
			await browser.execute((field, path) => {
				const select = document.querySelector(`[data-lun-field="${field}"]`) as HTMLSelectElement;
				select.value = path!; select.dispatchEvent(new Event('change', { bubbles: true }));
			}, field, path);
		}
		await browser.waitUntil(async () => browser.execute((sel: string) => (document.querySelector(sel) as HTMLButtonElement | null)?.disabled === false, SAVE), { timeout: 10000, timeoutMsg: 'Save pair (Pro) is not enabled after two files are chosen.' });
		await (await browser.$(SAVE)).click();
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes(LEAD)), { timeout: 5000 }).catch(async () => {
			throw new Error(`No Pro notice after Save pair (Pro): ${JSON.stringify(await notices())}`);
		});
		const shown = await notices();
		expect(shown.filter((n) => n.text.includes(LEAD))).toHaveLength(1);
		const notice = shown.find((n) => n.text.includes(LEAD))!;
		expect(notice.text).toContain(`${LEAD} ${PITCH}`);
		expect(notice.buttons).toBe(1);
		// The button opens the Sponsors page. window.open is replaced for this click only, so no page opens.
		const url = await browser.execute(() => {
			const w = window as unknown as { open: (u?: string) => unknown; activeWindow: Window };
			const original = w.open;
			let opened = '';
			w.open = (u?: string) => { opened = u ?? ''; return null; };
			try { (w.activeWindow.document.querySelector('.notice .pf-pro-notice-sponsor') as HTMLElement).click(); } finally { w.open = original; }
			return opened;
		});
		expect(url).toBe(`https://github.com/sponsors/theluckystrike?frequency=one-time&metadata_source=${pluginId}`);
		const pairs = await browser.executeObsidian(({ app }, id) => (app as unknown as { plugins: { plugins: Record<string, LockfileUpgradeNotesPlugin> } }).plugins.plugins[id]!.settings.pairs.length, pluginId);
		expect(pairs).toBe(0);
	});
});
