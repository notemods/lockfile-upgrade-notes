import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import LockfileUpgradeNotesPlugin from '../src/main';
import { DEFAULT_SETTINGS, MAX_BASELINES, MAX_PAIRS, normalizeSettings, safeReportName } from '../src/settings';
import { SPONSORS, bindPro, isPro, onProChange, resetPro } from '../src/pro';
import manifest from '../manifest.json';
import vectors from './fixtures/vectors.json';

const OLD = JSON.stringify({ lockfileVersion: 2, packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.0' } } });
const NEW = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.1' } } });
function make(files: Record<string, string> = {}) {
	const app = App.createConfigured__({ files: { 'old/package-lock.json': OLD, 'new/package-lock.json': NEW, ...files } });
	const plugin = new LockfileUpgradeNotesPlugin(app as never, manifest as never);
	vi.spyOn(plugin, 'saveSettings').mockResolvedValue();
	return { app, plugin };
}
function pro(on = true) { bindPro({ isPro: () => on, onChange: () => () => undefined } as never); }
afterEach(() => { resetPro(); vi.restoreAllMocks(); });

describe('vault reports', () => {
	it('compares offline, creates a numbered report, and keeps the sources unchanged', async () => {
		const vector = vectors.cases.find((c) => c.name.startsWith('10 '))!;
		const vaultCase = vector.vault_case!;
		const { app, plugin } = make(Object.fromEntries(vaultCase.existingReports.map((path) => [path, 'Keep me'])));
		await app.vault.modify(app.vault.getFileByPath(vaultCase.oldPath)!, vector.args[0]!);
		await app.vault.modify(app.vault.getFileByPath(vaultCase.newPath)!, vector.args[1]!);
		const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
		const preview = await plugin.compare('old/package-lock.json', 'new/package-lock.json');
		const report = await plugin.createReport(preview);
		expect(report.path).toBe(vaultCase.expectedPath);
		for (const text of vaultCase.expectedText) expect(await app.vault.read(report as never)).toContain(text);
		expect(await app.vault.read(report as never)).toContain('| patch |');
		expect(await app.vault.read(app.vault.getFileByPath(vaultCase.oldPath)!)).toBe(vector.args[0]);
		expect(await app.vault.read(app.vault.getFileByPath(vaultCase.newPath)!)).toBe(vector.args[1]);
		expect(await app.vault.read(app.vault.getFileByPath('Lockfile upgrade report.md')!)).toBe('Keep me');
		expect(network).not.toHaveBeenCalled();
		expect(isPro()).toBe(false);
	});
	it('handles concurrent creates without overwriting a report', async () => {
		const { plugin } = make(); const preview = await plugin.compare('old/package-lock.json', 'new/package-lock.json');
		const files = await Promise.all([plugin.createReport(preview), plugin.createReport(preview)]);
		expect(new Set(files.map((f) => f.path)).size).toBe(2);
	});
	it.each(['bad.json', 'v1.json', 'missing.json'])('rejects %s before a report can be made', async (path) => {
		const { app, plugin } = make({ 'bad.json': '{bad', 'v1.json': '{"lockfileVersion":1}' });
		const create = vi.spyOn(app.vault, 'create');
		await expect(plugin.compare(path, 'new/package-lock.json')).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	});
	it('rejects a folder as a lockfile', async () => {
		const { plugin } = make(); await expect(plugin.readLock('old')).rejects.toThrow('Select a file');
	});
	it('checks file size before reading', async () => {
		const { app, plugin } = make(); const file = app.vault.getFileByPath('old/package-lock.json')!;
		file.stat.size = 2 * 1024 * 1024 + 1;
		const read = vi.spyOn(app.vault, 'read');
		await expect(plugin.readLock(file.path)).rejects.toThrow('2 MiB'); expect(read).not.toHaveBeenCalled();
	});
	it('does not retry a non-collision write error', async () => {
		const { app, plugin } = make(); const preview = await plugin.compare('old/package-lock.json', 'new/package-lock.json');
		const create = vi.spyOn(app.vault, 'create').mockRejectedValue(new Error('disk full'));
		await expect(plugin.createReport(preview)).rejects.toThrow('disk full'); expect(create).toHaveBeenCalledTimes(1);
	});
});

describe('local Pro data', () => {
	it('guards pair save, pair load, baseline save and baseline compare', async () => {
		const { plugin } = make();
		await expect(plugin.savePair('P', 'old/package-lock.json', 'new/package-lock.json')).rejects.toThrow('Pro');
		expect(() => plugin.loadPair('P')).toThrow('Pro');
		await expect(plugin.saveBaseline('P', 'new/package-lock.json')).rejects.toThrow('Pro');
		await expect(plugin.compareBaseline('P', 'new/package-lock.json')).rejects.toThrow('Pro');
		expect(plugin.settings.pairs).toEqual([]); expect(plugin.settings.baselines).toEqual([]);
	});
	it('saves and replaces one named pair and reads it through the Pro guard', async () => {
		pro(); const { plugin } = make();
		await plugin.savePair(' P ', 'old/package-lock.json', 'new/package-lock.json');
		await plugin.savePair('P', 'new/package-lock.json', 'old/package-lock.json');
		expect(plugin.settings.pairs).toHaveLength(1);
		expect(plugin.loadPair('P').oldPath).toBe('new/package-lock.json');
		const copy = plugin.loadPair('P'); copy.name = 'changed'; expect(plugin.settings.pairs[0]?.name).toBe('P');
	});
	it('keeps a baseline after its source changes, and survives saved-data reload', async () => {
		pro(); const { app, plugin } = make();
		await plugin.saveBaseline('P', 'old/package-lock.json');
		const stored = JSON.parse(JSON.stringify(plugin.settings));
		await app.vault.modify(app.vault.getFileByPath('old/package-lock.json')!, NEW);
		plugin.settings = normalizeSettings(stored);
		const preview = await plugin.compareBaseline('P', 'new/package-lock.json');
		expect(preview.comparison.rows[0]).toMatchObject({ oldVersion: '1.0.0', newVersion: '1.0.1', label: 'patch' });
		expect(preview.baseline?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const file = await plugin.createReport(preview);
		expect(await app.vault.read(file as never)).toContain('local baseline P');
		pro(false); await expect(plugin.createReport(preview)).rejects.toThrow('Pro');
	});
	it('lets the user remove saved data after Pro turns off', async () => {
		pro(); const { plugin } = make(); await plugin.savePair('P', 'old/package-lock.json', 'new/package-lock.json'); await plugin.saveBaseline('P', 'old/package-lock.json');
		pro(false); await plugin.removeSaved('pair', 'P'); await plugin.removeSaved('baseline', 'P');
		expect(plugin.settings.pairs).toEqual([]); expect(plugin.settings.baselines).toEqual([]);
	});
	it('rolls back pair and baseline memory when settings cannot be saved', async () => {
		pro(); const { plugin } = make(); vi.mocked(plugin.saveSettings).mockRejectedValue(new Error('disk full'));
		await expect(plugin.savePair('P', 'old/package-lock.json', 'new/package-lock.json')).rejects.toThrow('disk full');
		await expect(plugin.saveBaseline('P', 'new/package-lock.json')).rejects.toThrow('disk full');
		expect(plugin.settings.pairs).toEqual([]); expect(plugin.settings.baselines).toEqual([]);
	});
	it('enforces pair and baseline count limits but allows replacement', async () => {
		pro(); const { plugin } = make();
		for (let i = 0; i < MAX_PAIRS; i++) await plugin.savePair(`P${i}`, 'old/package-lock.json', 'new/package-lock.json');
		await expect(plugin.savePair('Extra', 'old/package-lock.json', 'new/package-lock.json')).rejects.toThrow('20');
		await expect(plugin.savePair('P0', 'old/package-lock.json', 'new/package-lock.json')).resolves.toBeUndefined();
		for (let i = 0; i < MAX_BASELINES; i++) await plugin.saveBaseline(`P${i}`, 'old/package-lock.json');
		await expect(plugin.saveBaseline('Extra', 'old/package-lock.json')).rejects.toThrow('10');
		await expect(plugin.saveBaseline('P0', 'new/package-lock.json')).resolves.toBeUndefined();
	});
});

describe('settings and Pro facade', () => {
	it('loads default settings in a memory vault', async () => { const { plugin } = make(); await plugin.loadSettings(); expect(plugin.settings).toEqual(DEFAULT_SETTINGS); });
	it('repairs invalid saved data and report paths', () => {
		expect(normalizeSettings({ reportName: 1, pairs: 'bad', baselines: [null, { name: 'x', text: '{bad' }] })).toEqual(DEFAULT_SETTINGS);
		expect(safeReportName('../folder/[name]#^')).toBe('folder name');
		expect(safeReportName('...')).toBe(DEFAULT_SETTINGS.reportName);
	});
	it('uses the same sponsor terms as the reference', () => { expect(SPONSORS).toEqual({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' }); });
	it('updates listeners and clears them on unload', () => {
		let state = false; let listener = () => undefined;
		const unbind = vi.fn(); bindPro({ isPro: () => state, onChange: (fn: () => void) => { listener = fn; return unbind; } } as never);
		const change = vi.fn(); const off = onProChange(change); state = true; listener(); expect(isPro()).toBe(true); expect(change).toHaveBeenCalledTimes(1);
		off(); state = false; listener(); expect(change).toHaveBeenCalledTimes(1); resetPro(); expect(unbind).toHaveBeenCalled(); expect(isPro()).toBe(false);
	});
});

describe('saved data write failures', () => {
	it('keeps a later successful pair when an earlier write fails', async () => {
		pro(); const { app, plugin } = make();
		let rejectFirst!: (error: Error) => void;
		const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
		vi.mocked(plugin.saveSettings).mockImplementationOnce(() => firstWrite);
		const read = vi.spyOn(app.vault, 'read');
		const first = plugin.savePair('First', 'old/package-lock.json', 'new/package-lock.json');
		const failure = expect(first).rejects.toThrow('disk full');
		await vi.waitFor(() => expect(plugin.saveSettings).toHaveBeenCalledTimes(1));
		const second = plugin.savePair('Second', 'old/package-lock.json', 'new/package-lock.json');
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
		rejectFirst(new Error('disk full'));
		await failure; await second;
		expect(plugin.settings.pairs.map((p) => p.name)).toEqual(['Second']);
	});
	it('keeps a later saved pair when a removal write fails', async () => {
		pro(); const { app, plugin } = make();
		await plugin.savePair('Keep', 'old/package-lock.json', 'new/package-lock.json');
		let rejectFirst!: (error: Error) => void;
		const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
		vi.mocked(plugin.saveSettings).mockImplementationOnce(() => firstWrite);
		const read = vi.spyOn(app.vault, 'read');
		const removal = plugin.removeSaved('pair', 'Keep');
		const failure = expect(removal).rejects.toThrow('disk full');
		const next = plugin.savePair('Next', 'old/package-lock.json', 'new/package-lock.json');
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
		rejectFirst(new Error('disk full'));
		await failure; await next;
		expect(plugin.settings.pairs.map((p) => p.name)).toEqual(['Keep', 'Next']);
	});
});

describe('startup cleanup', () => {
	it('does not finish setup when saved data arrives after unload', async () => {
		const { plugin } = make();
		let finishLoad!: () => void;
		vi.spyOn(plugin, 'loadSettings').mockImplementation(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
		const command = vi.spyOn(plugin, 'addCommand').mockImplementation(() => undefined as never);
		const loading = plugin.onload(); plugin.onunload(); finishLoad(); await loading;
		expect(command).not.toHaveBeenCalled();
		expect(plugin.pro).toBeNull();
	});
	it('does not start a timer when the layout becomes ready after unload', async () => {
		const { app, plugin } = make();
		let ready!: () => void;
		vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => { ready = callback; });
		vi.spyOn(plugin, 'addSettingTab').mockImplementation(() => undefined);
		vi.spyOn(plugin, 'addCommand').mockImplementation(() => undefined as never);
		vi.spyOn(app, 'loadLocalStorage').mockReturnValue(null);
		const timer = vi.spyOn(window, 'setInterval').mockReturnValue(1);
		await plugin.onload();
		const refresh = vi.spyOn(plugin.pro!, 'refresh');
		plugin.onunload(); ready();
		expect(timer).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});
});

describe('report title writes', () => {
	it('restores the saved title after a write failure and permits the next change', async () => {
		const { plugin } = make();
		vi.mocked(plugin.saveSettings).mockRejectedValueOnce(new Error('disk full'));
		await expect(plugin.setReportName('Failed title')).rejects.toThrow('disk full');
		expect(plugin.settings.reportName).toBe(DEFAULT_SETTINGS.reportName);
		await plugin.setReportName('Reports/Next');
		expect(plugin.settings.reportName).toBe('Reports Next');
	});
});
