// Obsidian adapter: requestUrl transport, device-local storage, settings rows and a Pro guard.
// Products import it as the ./obsidian entry of this package. The policy itself lives in policy.ts and has no obsidian import.
import { Notice, requestUrl, type App, type Setting, type SettingDefinitionItem } from 'obsidian';
import { LicenseManager, type LicenseStore } from './policy';
import type { HttpClient, LicenseProvider, LicenseState } from './types';

/** HttpClient over requestUrl (works on desktop and mobile, no CORS). Never throws on 4xx/5xx. */
export const requestUrlClient: HttpClient = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
	let json: unknown = null;
	try {
		json = res.json as unknown;
	} catch {
		json = null;
	}
	return { status: res.status, json };
};

/**
 * requestUrlClient that refuses every host but the provider's. fx check (tools/network-gate.mjs) allows this
 * transport as the one requestUrl call with a non-literal URL, so the lock keeps that exception honest at run time.
 */
export function hostLockedClient(hosts: readonly string[], inner: HttpClient = requestUrlClient): HttpClient {
	const allowed = new Set(hosts.map((h) => h.toLowerCase()));
	return (req) => {
		let host = '';
		try {
			const u = new URL(req.url);
			host = u.protocol === 'https:' ? u.host.toLowerCase() : '';
		} catch {
			host = '';
		}
		if (!allowed.has(host)) return Promise.reject(new Error(`blocked request to a host the license provider does not use: ${host || req.url}`));
		return inner(req);
	};
}

/**
 * Keeps the license in this device's localStorage for this vault, not in data.json:
 * the key never lands in vault files (synced or committed to git), and each device
 * holds its own activation, which is what a device limit means.
 * The same storage holds the Paid trial start, so clearing it restarts a trial without a key (see policy.ts).
 */
export function localLicenseStore(app: App, pluginId: string): LicenseStore {
	const slot = `${pluginId}-license`;
	return {
		load: () => Promise.resolve(app.loadLocalStorage(slot) as unknown),
		save: (state: LicenseState) => {
			app.saveLocalStorage(slot, state);
			return Promise.resolve();
		},
	};
}

/** Random, stable per-device label such as "reading-pace-3f9a1c0b7d2e". No host name, user name or other personal data. */
export function deviceLabel(app: App, pluginId: string): string {
	const slot = `${pluginId}-device`;
	const saved: unknown = app.loadLocalStorage(slot);
	if (typeof saved === 'string' && /^[0-9a-f]{12}$/.test(saved)) return `${pluginId}-${saved}`;
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	app.saveLocalStorage(slot, id);
	return `${pluginId}-${id}`;
}

/**
 * One call per plugin. Pass the provider instance (not a config union) so the bundle
 * holds only that seller's code and host:
 *   this.license = createLicense(this.app, this.manifest.id, new PolarProvider(PRO));
 *   await this.license.init();
 *   this.app.workspace.onLayoutReady(() => void this.license.refresh());
 */
export function createLicense(app: App, pluginId: string, provider: LicenseProvider, opts: { trialDays?: number } = {}): LicenseManager {
	return new LicenseManager({
		provider,
		http: hostLockedClient(provider.hosts),
		store: localLicenseStore(app, pluginId),
		deviceLabel: () => deviceLabel(app, pluginId),
		trialDays: opts.trialDays ?? 0,
	});
}

export interface LicenseUiOptions {
	/** Checkout link for the "Get Pro" row. */
	checkoutUrl: string;
	/** One sentence: what Pro adds. */
	proSummary: string;
}

function statusText(license: LicenseManager): string {
	const s = license.getState();
	if (s.status === 'none') {
		return license.inTrial() ? 'Trial active. Add a key to keep Pro features after the trial.' : 'No key. Free features work without one.';
	}
	return s.message || (license.isPro() ? 'Pro is active.' : 'Pro is off.');
}

/** Fills one settings row: key field, Activate, Check now and Remove. */
export function fillKeySetting(setting: Setting, license: LicenseManager): void {
	let pending = license.getState().key;
	const show = () => setting.setDesc(statusText(license));
	setting.setName('License key');
	show();
	setting.addText((t) => {
		t.inputEl.type = 'password';
		t.inputEl.autocomplete = 'off';
		t.setPlaceholder('Paste your key').setValue(pending);
		t.onChange((v) => {
			pending = v;
		});
	});
	setting.addButton((b) =>
		b
			.setButtonText('Activate')
			.setCta()
			.onClick(async () => {
				await license.setKey(pending);
				show();
			}),
	);
	setting.addExtraButton((b) =>
		b
			.setIcon('refresh-cw')
			.setTooltip('Check now')
			.onClick(async () => {
				await license.checkNow();
				show();
			}),
	);
	setting.addExtraButton((b) =>
		b
			.setIcon('trash')
			.setTooltip('Remove key')
			.onClick(async () => {
				pending = '';
				await license.clearKey();
				show();
			}),
	);
}

/** Fills the "Get Pro" row: what Pro adds and the checkout link. */
export function fillGetProSetting(setting: Setting, license: LicenseManager, ui: LicenseUiOptions): void {
	setting.setName('Get pro');
	setting.setDesc(
		createFragment((f) => {
			f.appendText(`${ui.proSummary} Sold by ${license.provider.seller}. `);
			f.createEl('a', { href: ui.checkoutUrl, text: 'Buy a license key' });
		}),
	);
}

/** Rows for a declarative settings tab (getSettingDefinitions). */
export function licenseSettingItems(license: LicenseManager, ui: LicenseUiOptions): SettingDefinitionItem[] {
	return [
		{ name: 'License key', render: (setting: Setting) => fillKeySetting(setting, license) },
		{ name: 'Get pro', render: (setting: Setting) => fillGetProSetting(setting, license, ui) },
	];
}

/** Wraps a Pro action. Without Pro it shows a notice and does nothing; notes are never touched. */
export function guardPro<A extends unknown[]>(license: LicenseManager, action: (...args: A) => unknown): (...args: A) => void {
	return (...args: A) => {
		if (license.isPro()) {
			void action(...args);
			return;
		}
		new Notice('This is a pro feature. Add a license key in the plugin settings.');
	};
}
