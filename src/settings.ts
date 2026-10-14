import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { parseLock, snapshot } from './compare';
import { PRO_UI } from './pro';
import type LockfileUpgradeNotesPlugin from './main';

export interface SavedPair { name: string; oldPath: string; newPath: string }
export interface Baseline { name: string; sourcePath: string; capturedAt: string; text: string }
export interface LockfileUpgradeNotesSettings { reportName: string; pairs: SavedPair[]; baselines: Baseline[] }
export const DEFAULT_SETTINGS: LockfileUpgradeNotesSettings = { reportName: 'Lockfile upgrade report', pairs: [], baselines: [] };
export const MAX_PAIRS = 20;
export const MAX_BASELINES = 10;

export function safeReportName(value: string): string {
	return value.replace(/[\\/:*?"<>|#^[\]\r\n]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '').trim().slice(0, 100) || DEFAULT_SETTINGS.reportName;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function normalizeSettings(saved: unknown): LockfileUpgradeNotesSettings {
	const s = record(saved) ? saved : {};
	const pairs: SavedPair[] = [];
	const baselines: Baseline[] = [];
	if (Array.isArray(s.pairs)) for (const p of s.pairs) {
		if (pairs.length >= MAX_PAIRS) break;
		if (record(p) && text(p.name) && text(p.oldPath) && text(p.newPath) && !pairs.some((v) => v.name === p.name)) pairs.push({ name: p.name.slice(0, 80), oldPath: p.oldPath, newPath: p.newPath });
	}
	if (Array.isArray(s.baselines)) for (const b of s.baselines) {
		if (baselines.length >= MAX_BASELINES) break;
		if (!record(b) || !text(b.name) || !text(b.sourcePath) || !text(b.capturedAt) || !text(b.text) || baselines.some((v) => v.name === b.name)) continue;
		try { baselines.push({ name: b.name.slice(0, 80), sourcePath: b.sourcePath, capturedAt: b.capturedAt, text: snapshot(parseLock(b.text)) }); }
		catch { /* Drop invalid saved snapshots. */ }
	}
	return { reportName: typeof s.reportName === 'string' ? safeReportName(s.reportName) : DEFAULT_SETTINGS.reportName, pairs, baselines };
}

export class LockfileUpgradeNotesSettingTab extends PluginSettingTab {
	plugin: LockfileUpgradeNotesPlugin;
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: LockfileUpgradeNotesPlugin) { super(app, plugin); this.plugin = plugin; }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Report name', desc: 'New reports go in the vault root. A number is added if the name exists.', control: { type: 'text', key: 'reportName', defaultValue: DEFAULT_SETTINGS.reportName } },
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key !== 'reportName' || typeof value !== 'string') return;
		await this.plugin.setReportName(value);
	}
}
