import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { compareLocks, parseLock, renderReport, snapshot, MAX_BYTES, type Comparison, type LockData } from './compare';
import { CompareModal } from './modal';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, LockfileUpgradeNotesSettingTab, MAX_BASELINES, MAX_PAIRS, normalizeSettings, safeReportName, type Baseline, type LockfileUpgradeNotesSettings, type SavedPair } from './settings';

export interface Preview { comparison: Comparison; oldPath: string; newPath: string; baseline?: Baseline }

export default class LockfileUpgradeNotesPlugin extends Plugin {
	settings: LockfileUpgradeNotesSettings = normalizeSettings(DEFAULT_SETTINGS);
	pro: SponsorsManager | null = null;
	private settingTab: LockfileUpgradeNotesSettingTab | null = null;
	private modals = new Set<CompareModal>();
	private reportPaths = new Set<string>();
	private unloaded = false;
	private settingsWrites: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		this.unloaded = false;
		await this.loadSettings();
		if (this.unloaded) return;
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init(); this.pro = pro; bindPro(pro);
		this.settingTab = new LockfileUpgradeNotesSettingTab(this.app, this);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.addSettingTab(this.settingTab);
		this.addCommand({ id: 'compare-lockfiles', name: 'Compare vault lockfiles', callback: () => { this.openCompare(); } });
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}
	onunload(): void { this.unloaded = true; for (const modal of this.modals) modal.close(); this.modals.clear(); resetPro(); }
	openCompare(oldPath = '', newPath = ''): CompareModal {
		const modal = new CompareModal(this, oldPath, newPath);
		this.modals.add(modal); modal.open(); return modal;
	}
	closed(modal: CompareModal): void { this.modals.delete(modal); }
	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData()); }
	async saveSettings(): Promise<void> { await this.saveData(this.settings); }
	/** Apply and save one change at a time. A failed write cannot undo a later change. */
	private updateSettings(change: (settings: LockfileUpgradeNotesSettings) => LockfileUpgradeNotesSettings): Promise<void> {
		const write = this.settingsWrites.then(async () => {
			const previous = this.settings;
			this.settings = change(previous);
			try { await this.saveSettings(); } catch (error) { this.settings = previous; throw error; }
		});
		this.settingsWrites = write.catch(() => undefined);
		return write;
	}
	async setReportName(name: string): Promise<void> {
		await this.updateSettings((settings) => ({ ...settings, reportName: safeReportName(name) }));
	}

	async readLock(path: string): Promise<LockData> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error('Select a file in the vault.');
		if (file.stat.size > MAX_BYTES) throw new Error('File exceeds 2 MiB.');
		return parseLock(await this.app.vault.read(file));
	}
	async compare(oldPath: string, newPath: string): Promise<Preview> {
		const a = normalizePath(oldPath); const b = normalizePath(newPath);
		const oldLock = await this.readLock(a); const newLock = await this.readLock(b);
		return { comparison: compareLocks(oldLock, newLock), oldPath: a, newPath: b };
	}
	async compareBaseline(name: string, newPath: string): Promise<Preview> {
		this.requirePro();
		const baseline = this.settings.baselines.find((b) => b.name === name);
		if (!baseline) throw new Error('Select a saved baseline.');
		return { comparison: compareLocks(parseLock(baseline.text), await this.readLock(newPath)), oldPath: baseline.sourcePath, newPath: normalizePath(newPath), baseline: { ...baseline } };
	}

	/** Vault.create refuses an existing file. Retry only a path collision. */
	async createReport(preview: Preview): Promise<TFile> {
		if (preview.baseline) this.requirePro();
		const name = safeReportName(this.settings.reportName);
		const report = renderReport(preview.comparison, preview.oldPath, preview.newPath, preview.baseline);
		for (let n = 1; n <= 1000; n++) {
			const path = normalizePath(`${name}${n === 1 ? '' : ` ${n}`}.md`);
			if (this.reportPaths.has(path) || this.app.vault.getAbstractFileByPath(path)) continue;
			this.reportPaths.add(path);
			try { return await this.app.vault.create(path, report); }
			catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
			finally { this.reportPaths.delete(path); }
		}
		throw new Error('Report names 1 to 1000 are in use. Change the report name.');
	}
	async openReport(file: TFile): Promise<void> { await this.app.workspace.openLinkText(file.path, '', false); }
	private requirePro(): void { if (!isPro()) throw new Error('This is a Pro feature. Sponsor on GitHub, then sign in from the plugin settings.'); }
	private projectName(name: string): string { const result = name.trim().slice(0, 80); if (!result) throw new Error('Enter a project name.'); return result; }

	async savePair(name: string, oldPath: string, newPath: string): Promise<void> {
		this.requirePro();
		const pair: SavedPair = { name: this.projectName(name), oldPath: normalizePath(oldPath), newPath: normalizePath(newPath) };
		await this.compare(pair.oldPath, pair.newPath);
		await this.updateSettings((settings) => {
			this.requirePro();
			const existing = settings.pairs.findIndex((p) => p.name === pair.name);
			if (existing < 0 && settings.pairs.length >= MAX_PAIRS) throw new Error('You can save up to 20 pairs. Remove a pair first.');
			return { ...settings, pairs: existing < 0 ? [...settings.pairs, pair] : settings.pairs.map((p, i) => i === existing ? pair : p) };
		});
	}
	loadPair(name: string): SavedPair {
		this.requirePro(); const pair = this.settings.pairs.find((p) => p.name === name);
		if (!pair) throw new Error('Select a saved pair.'); return { ...pair };
	}
	async saveBaseline(name: string, sourcePath: string): Promise<void> {
		this.requirePro(); const project = this.projectName(name);
		const lock = await this.readLock(sourcePath); this.requirePro();
		const baseline: Baseline = { name: project, sourcePath: normalizePath(sourcePath), capturedAt: new Date().toISOString(), text: snapshot(lock) };
		// The stored snapshot must fit the same limits when it is read again.
		parseLock(baseline.text);
		await this.updateSettings((settings) => {
			this.requirePro();
			const existing = settings.baselines.findIndex((b) => b.name === project);
			if (existing < 0 && settings.baselines.length >= MAX_BASELINES) throw new Error('You can save up to 10 baselines. Remove a baseline first.');
			return { ...settings, baselines: existing < 0 ? [...settings.baselines, baseline] : settings.baselines.map((b, i) => i === existing ? baseline : b) };
		});
	}
	/** Remove saved local data even when Pro is off. */
	async removeSaved(kind: 'pair' | 'baseline', name: string): Promise<void> {
		await this.updateSettings((settings) => ({ ...settings, pairs: kind === 'pair' ? settings.pairs.filter((p) => p.name !== name) : settings.pairs, baselines: kind === 'baseline' ? settings.baselines.filter((b) => b.name !== name) : settings.baselines }));
	}
	notice(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }
}
