import { Modal, Setting, type ButtonComponent } from 'obsidian';
import { VERSION_ONLY, type ChangeRow } from './compare';
import type LockfileUpgradeNotesPlugin from './main';
import type { Preview } from './main';
import { isPro, onProChange, proText } from './pro';

/** Keep the product tier name in the required heading suffix. */
function proHeading(title: string): string { return `${title} (Pro)`; }

export class CompareModal extends Modal {
	oldPath: string;
	newPath: string;
	preview: Preview | null = null;
	private project = '';
	private pairName = '';
	private baselineName = '';
	private error = '';
	private busy = false;
	private buttons: ButtonComponent[] = [];
	private off: (() => void) | null = null;
	constructor(private plugin: LockfileUpgradeNotesPlugin, oldPath: string, newPath: string) {
		super(plugin.app); this.modalEl.classList.add('lun-dialog'); this.oldPath = oldPath; this.newPath = newPath;
	}
	onOpen(): void { this.off = onProChange(() => this.render()); this.render(); }
	onClose(): void { this.off?.(); this.off = null; this.contentEl.empty(); this.plugin.closed(this); }

	private button(setting: Setting, label: string, action: () => Promise<void>, enabled = true): void {
		setting.addButton((button) => {
			button.setButtonText(label).setDisabled(!enabled || this.busy).onClick(() => this.run(action));
			button.buttonEl.dataset.lunAction = label;
			this.buttons.push(button);
		});
	}
	private async run(action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true; this.error = ''; this.buttons.forEach((b) => { b.setDisabled(true); });
		try { await action(); }
		catch (error) { this.error = error instanceof Error ? error.message : String(error); this.plugin.notice(error); }
		finally { this.busy = false; if (this.contentEl.isConnected) this.render(); }
	}

	async previewFiles(): Promise<void> {
		this.preview = null;
		this.preview = await this.plugin.compare(this.oldPath, this.newPath);
		this.render();
	}
	private changed(): void { this.preview = null; this.error = ''; this.render(); }

	render(): void {
		const el = this.contentEl;
		el.empty(); el.classList.add('lun-modal'); this.buttons = [];
		this.setTitle('Compare lockfiles');
		el.createEl('p', { text: 'Choose two JSON files in this vault. npm lockfile versions 2 and 3 are supported. Limit: 2 MiB and 10,000 package entries per file.' });
		const files = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'json').sort((a, b) => a.path.localeCompare(b.path));
		for (const [title, key] of [['Old lockfile', 'oldPath'], ['New lockfile', 'newPath']] as const) {
			new Setting(el).setName(title).addDropdown((d) => {
				d.addOption('', 'Choose a vault file');
				for (const file of files) d.addOption(file.path, file.path);
				d.setValue(this[key]).setDisabled(this.busy).onChange((path) => { this[key] = path; this.changed(); });
				d.selectEl.dataset.lunField = key; d.selectEl.setAttribute('aria-label', title);
			});
		}
		const actions = new Setting(el).setName('Version comparison');
		this.button(actions, 'Compare versions', async () => this.previewFiles(), !!this.oldPath && !!this.newPath);
		this.button(actions, 'Create report', async () => {
			if (!this.preview) return;
			const file = await this.plugin.createReport(this.preview); this.close(); await this.plugin.openReport(file);
		}, !!this.preview);
		if (this.error) el.createEl('p', { text: this.error, cls: 'lun-error', attr: { role: 'alert' } });
		if (this.preview) this.renderPreview(el, this.preview);
		this.renderPro(el);
	}
	private renderPreview(el: HTMLElement, preview: Preview): void {
		const { rows, unchanged } = preview.comparison;
		const count = (status: ChangeRow['status']) => rows.filter((r) => r.status === status).length;
		const summary = `${count('added')} added · ${count('removed')} removed · ${count('changed')} changed · ${count('unsupported')} unsupported or incomplete · ${unchanged} unchanged versions`;
		el.createEl('p', { text: summary, cls: 'lun-summary' });
		el.createEl('p', { text: VERSION_ONLY, cls: 'lun-hint' });
		if (preview.baseline) el.createEl('p', { text: `Local baseline: ${preview.baseline.name}, saved ${preview.baseline.capturedAt}. The old link opens the current source file.` });
		const wrap = el.createDiv({ cls: 'lun-table-wrap' });
		const table = wrap.createEl('table', { cls: 'lun-table' });
		const head = table.createEl('thead').createEl('tr');
		for (const label of ['Package and installation path', 'Old', 'New', 'Status', 'Label']) head.createEl('th', { text: label, attr: { scope: 'col' } });
		const body = table.createEl('tbody');
		// The report contains the complete result. Keep the preview bounded.
		for (const row of rows.slice(0, 200)) {
			const tr = body.createEl('tr'); tr.dataset.lunPath = row.path;
			const packageCell = tr.createEl('td');
			packageCell.createEl('strong', { text: row.name });
			if (row.direct) packageCell.createSpan({ text: 'Direct', cls: 'lun-direct' });
			packageCell.createDiv({ text: row.path, cls: 'lun-path' });
			tr.createEl('td', { text: row.oldVersion ?? '—' }); tr.createEl('td', { text: row.newVersion ?? '—' });
			tr.createEl('td', { text: row.status });
			tr.createEl('td', { text: row.reason || `${row.label ?? '—'}${row.downgrade ? ' · downgrade' : ''}` });
		}
		if (!rows.length) el.createEl('p', { text: 'No added, removed or changed versions, or unsupported entries, were found.' });
		if (rows.length > 200) el.createEl('p', { text: 'Preview shows the first 200 rows. The report includes the complete result.' });
	}
	private renderPro(el: HTMLElement): void {
		new Setting(el).setName(proHeading('Saved projects')).setHeading();
		el.createEl('p', { text: isPro() ? 'Pro is active. Save up to 20 pairs and 10 local baselines.' : proText('Pro adds named pairs and local baselines.'), cls: 'lun-hint' });
		new Setting(el).setName('Project name').addText((t) => t.setValue(this.project).setDisabled(this.busy).onChange((v) => { this.project = v; }));
		const save = new Setting(el).setName('Save project');
		this.button(save, 'Save pair (Pro)', async () => { await this.plugin.savePair(this.project, this.oldPath, this.newPath); this.pairName = this.project.trim().slice(0, 80); }, !!this.oldPath && !!this.newPath);
		this.button(save, 'Save new file as baseline (Pro)', async () => { await this.plugin.saveBaseline(this.project, this.newPath); this.baselineName = this.project.trim().slice(0, 80); }, !!this.newPath);
		const pairs = new Setting(el).setName(proHeading('Named pair')).addDropdown((d) => {
			d.addOption('', 'Choose a pair'); for (const p of this.plugin.settings.pairs) d.addOption(p.name, p.name);
			d.setValue(this.pairName).setDisabled(this.busy).onChange((v) => { this.pairName = v; this.render(); });
		});
		this.button(pairs, 'Load pair (Pro)', async () => { const pair = this.plugin.loadPair(this.pairName); this.oldPath = pair.oldPath; this.newPath = pair.newPath; this.preview = null; }, !!this.pairName);
		this.button(pairs, 'Remove pair', async () => { await this.plugin.removeSaved('pair', this.pairName); this.pairName = ''; }, !!this.pairName);
		const baselines = new Setting(el).setName(proHeading('Project baseline')).addDropdown((d) => {
			d.addOption('', 'Choose a baseline'); for (const b of this.plugin.settings.baselines) d.addOption(b.name, b.name);
			d.setValue(this.baselineName).setDisabled(this.busy).onChange((v) => { this.baselineName = v; this.render(); });
		});
		this.button(baselines, 'Compare baseline (Pro)', async () => { this.preview = null; this.preview = await this.plugin.compareBaseline(this.baselineName, this.newPath); }, !!this.baselineName && !!this.newPath);
		this.button(baselines, 'Remove baseline', async () => { await this.plugin.removeSaved('baseline', this.baselineName); this.baselineName = ''; }, !!this.baselineName);
	}
}
