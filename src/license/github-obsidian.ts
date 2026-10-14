// Obsidian adapter for the GitHub Sponsors Pro check: requestUrl transport, SecretStorage token,
// device-local state, the "Get Pro" settings rows and a Pro guard.
// Products import it as the ./github-obsidian entry of this package.
import { Notice, requestUrl, type App, type Component, type RequestUrlResponsePromise, type Setting, type SettingDefinitionItem } from 'obsidian';
import { ACCESS_TOKEN_URL, DEVICE_CODE_URL, GRAPHQL_URL, sponsorUrl, type DeviceCode, type SponsorsConfig } from './github';
import { SponsorsManager, type SponsorsState, type SponsorsStateStore, type TokenStore } from './sponsors';
import type { HttpClient, HttpRequest, HttpResponse } from './types';

async function toResponse(p: RequestUrlResponsePromise): Promise<HttpResponse> {
	const res = await p;
	let json: unknown = null;
	try {
		json = res.json as unknown;
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

/**
 * The only three requests this check can make, each with a literal URL (fx check, tools/network-gate.mjs,
 * reads them from main.js). Any other URL is refused before it leaves the device.
 */
export const githubRequestClient: HttpClient = (req: HttpRequest) => {
	const { headers, body } = req;
	if (req.url === DEVICE_CODE_URL) return toResponse(requestUrl({ url: 'https://github.com/login/device/code', method: 'POST', headers, body, throw: false }));
	if (req.url === ACCESS_TOKEN_URL) return toResponse(requestUrl({ url: 'https://github.com/login/oauth/access_token', method: 'POST', headers, body, throw: false }));
	if (req.url === GRAPHQL_URL) return toResponse(requestUrl({ url: 'https://api.github.com/graphql', method: 'POST', headers, body, throw: false }));
	return Promise.reject(new Error('blocked request: not a GitHub sign in or sponsorship URL'));
};

/** SecretStorage ids are lowercase letters, digits and dashes. */
export function secretId(pluginId: string): string {
	return `${pluginId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-github-token`;
}

/**
 * Keeps the GitHub token in Obsidian's SecretStorage (app.secretStorage, Obsidian 1.11.4+), never in data.json.
 * SecretStorage has no delete call, so sign out writes an empty string. Without SecretStorage the token is
 * kept in memory only and the user signs in again after a restart.
 */
export function secretTokenStore(app: App, pluginId: string): TokenStore {
	const id = secretId(pluginId);
	const storage = (app as Partial<Pick<App, 'secretStorage'>>).secretStorage;
	let memory: string | null = null;
	const usable = !!storage && typeof storage.getSecret === 'function' && typeof storage.setSecret === 'function';
	return {
		get: () => {
			if (!usable) return memory;
			const v = storage.getSecret(id);
			return typeof v === 'string' && v !== '' ? v : null;
		},
		set: (token: string) => {
			if (usable) storage.setSecret(id, token);
			else memory = token;
		},
		clear: () => {
			if (usable) storage.setSecret(id, '');
			memory = null;
		},
	};
}

/** The login, tier and check times live in this device's local storage for this vault. Never the token. */
export function localSponsorsStore(app: App, pluginId: string): SponsorsStateStore {
	const slot = `${pluginId}-github-sponsors`;
	return {
		load: () => app.loadLocalStorage(slot) as unknown,
		save: (state: SponsorsState) => app.saveLocalStorage(slot, state),
	};
}

/**
 *   this.pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
 *   this.pro.init();                                   // no request
 *   this.app.workspace.onLayoutReady(() => void this.pro.refresh());  // a request only when signed in and due
 * owner is the plugin: its unload disposes the manager, so a sign-in poll or a check never outlives the plugin.
 */
export function createGitHubSponsors(app: App, pluginId: string, config: SponsorsConfig, owner: Pick<Component, 'register'>): SponsorsManager {
	const pro = new SponsorsManager({ config, http: githubRequestClient, tokens: secretTokenStore(app, pluginId), store: localSponsorsStore(app, pluginId) });
	owner.register(() => pro.dispose());
	return pro;
}

export interface SponsorsUiOptions {
	/** One sentence: what Pro adds. */
	proSummary: string;
	/** One sentence: the price, for example "$3 a month or more, or $15 once for life." */
	priceText: string;
	/** Status text when the product needs a separate account for its free service. */
	signedOutText?: string;
}

/** The status line of the account row. */
export function sponsorsStatusText(pro: SponsorsManager, signedOutText?: string): string {
	const s = pro.getState();
	if (!pro.isConfigured()) return 'Sign in with GitHub is not set up in this version yet. Free features work as normal.';
	if (s.status === 'signed-out') {
		const lead = s.message ? `${s.message} ` : '';
		return `${lead}${signedOutText ?? 'Not signed in. Free features work without an account. Nothing is sent to GitHub until you select Sign in with GitHub.'}`;
	}
	if (s.status === 'unchecked') return s.message || 'Signed in. Checking the sponsorship with GitHub.';
	if (s.status === 'no') return `${s.message} After you sponsor, select Refresh.`;
	return s.message || (pro.isPro() ? 'Pro is active.' : 'Pro is off.');
}

function openUrl(url: string): void {
	window.open(url);
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** Fills the "Get Pro" row: what Pro adds, the price and the Sponsor button. */
export function fillGetProSetting(setting: Setting, pro: SponsorsManager, ui: SponsorsUiOptions): void {
	setting.setName('Get pro');
	setting.setDesc(`${ui.proSummary} ${ui.priceText} Sponsor on GitHub, then sign in below with the same GitHub account.`);
	setting.addButton((b) =>
		b
			.setButtonText('Sponsor on GitHub')
			.setCta()
			.onClick(() => openUrl(sponsorUrl(pro.config))),
	);
}

/** Shows the user code while the device flow waits; returns a cleanup that cancels the wait. */
function runSignIn(setting: Setting, pro: SponsorsManager, code: DeviceCode, redraw: () => void): () => void {
	let cancelled = false;
	setting.controlEl.empty();
	setting.setDesc(
		createFragment((f) => {
			f.appendText('Enter this code at ');
			f.createEl('a', { href: code.verificationUri, text: code.verificationUri });
			f.appendText(': ');
			f.createEl('code', { text: code.userCode, cls: 'pf-github-user-code' });
			f.appendText('. The code is copied. Waiting for GitHub.');
		}),
	);
	setting.addButton((b) =>
		b.setButtonText('Cancel').onClick(() => {
			cancelled = true;
			redraw();
		}),
	);
	void copyText(code.userCode);
	openUrl(code.verificationUri);
	void pro.finishSignIn(code, () => cancelled).then((r) => {
		if (cancelled) return;
		if (r.kind === 'expired') new Notice('The GitHub code expired. Start the sign in again to get a new code.');
		else if (r.kind === 'denied') new Notice('Sign in was cancelled on GitHub.');
		else if (r.kind === 'error') new Notice(r.reason);
		redraw();
	});
	return () => {
		cancelled = true;
	};
}

/** Fills the account row: status line, Sign in with GitHub, Refresh and Sign out. Returns a cleanup. */
export function fillAccountSetting(setting: Setting, pro: SponsorsManager, ui?: SponsorsUiOptions): () => void {
	let stop: () => void = () => undefined;
	// Set when Obsidian closes or redraws the row; work that ends later must not touch the row or start a sign in.
	let disposed = false;
	const redraw = () => {
		stop();
		if (disposed) return;
		setting.controlEl.empty();
		setting.setName('GitHub account');
		setting.setDesc(sponsorsStatusText(pro, ui?.signedOutText));
		if (!pro.hasToken()) {
			setting.addButton((b) =>
				b
					.setButtonText('Sign in with GitHub')
					.setDisabled(!pro.isConfigured())
					.onClick(async () => {
						b.setDisabled(true);
						const start = await pro.startSignIn();
						if (disposed) return;
						if (start.kind === 'error') {
							new Notice(start.reason);
							redraw();
							return;
						}
						stop = runSignIn(setting, pro, start.code, redraw);
					}),
			);
			return;
		}
		setting.addButton((b) =>
			b.setButtonText('Refresh').onClick(async () => {
				b.setDisabled(true);
				await pro.refreshNow();
				redraw();
			}),
		);
		setting.addButton((b) =>
			b.setButtonText('Sign out').onClick(() => {
				pro.signOut();
				redraw();
			}),
		);
	};
	redraw();
	return () => {
		disposed = true;
		stop();
	};
}

/** Rows for a declarative settings tab (getSettingDefinitions). */
export function sponsorsSettingItems(pro: SponsorsManager, ui: SponsorsUiOptions): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			heading: 'Pro',
			items: [
				{ name: 'Get pro', render: (setting: Setting) => fillGetProSetting(setting, pro, ui) },
				{ name: 'GitHub account', render: (setting: Setting) => fillAccountSetting(setting, pro, ui) },
			],
		},
	];
}

/** Wraps a Pro action. Without Pro it shows a notice and does nothing; notes are never touched. */
export function guardSponsorsPro<A extends unknown[]>(pro: SponsorsManager, action: (...args: A) => unknown): (...args: A) => void {
	return (...args: A) => {
		if (pro.isPro()) {
			void action(...args);
			return;
		}
		new Notice('This is a pro feature. Sponsor on GitHub, then sign in from the plugin settings.');
	};
}
