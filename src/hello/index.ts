// "What's new" after a plugin update: one background tab, once, in the plugin's own interface.
// The text is bundled at build time (src/whats-new.json of the product, made by tools/hello-content.mjs). This file
// sends no request and counts nothing. The decision logic is host-free and lives in the core package (core/hello.ts);
// this file is the Obsidian part.
// Call setupHello(this, content) at the start of Plugin.onload. It does not wait for disk reads: the check runs
// after the workspace layout is ready and after the product's first loadData() (see HelloOptions.after).
import { ItemView, Platform, Setting, type Plugin, type WorkspaceLeaf } from 'obsidian';
import {
	HELLO_DATA_KEY,
	HELLO_DEFAULT_STATE,
	HELLO_SHARED_KEY,
	decideHello,
	helloChatUrl,
	helloFeedbackUrl,
	helloPageUrl,
	normalizeHelloContent,
	pluginPageUrl,
	type HelloContent,
	type HelloDecision,
	type HelloLastShown,
	type HelloState,
	readHelloState,
} from '../core/index';

/** Brand names stay out of sentence case. */
export const HELLO_BRAND = 'NoteMods';
export const HELLO_CHAT_NAME = 'Zovo Chat';
/** CSS classes; the product styles.css may style them (tools/hello-wire.mjs adds the rules). */
export const HELLO_CLS = 'notemods-hello';

export interface HelloOptions {
	/** Add the "Show what's new" command. Default true. */
	command?: boolean;
	/** Add the "Send feedback" command. Default true. */
	feedbackCommand?: boolean;
	/**
	 * The start check waits for this before it reads data.json and writes the hello state. Use it when the product
	 * hands its data over from an earlier instance (disable and enable, a module update), for example
	 * `after: () => this.loading`. Without it, the check waits for the product's first loadData() to finish, at most
	 * HELLO_PRODUCT_WAIT_MS. A product that waits for its old instance before it reads its data is then safe.
	 */
	after?: () => unknown;
}

/** The longest wait for the product's first loadData() before the start check runs without it. */
export const HELLO_PRODUCT_WAIT_MS = 30_000;

/** Vault localStorage (App.loadLocalStorage, since 1.8.7), checked at run time so an older app never breaks. */
interface VaultStorage {
	loadLocalStorage?: (key: string) => unknown;
	saveLocalStorage?: (key: string, data: unknown) => void;
}

/**
 * Makes the tab class of one controller: the tab that shows the bundled changes or tip, the thank-you text and the
 * NoteMods links. Obsidian's View constructor calls getViewType() (it sets data-type on the container) before the
 * constructor body of a subclass runs. So the type, title and icon come from this closure and never from an instance
 * field. A field is still undefined at that time, and Obsidian then shows "Plugin no longer active" in the tab.
 */
export function whatsNewViewClass(hello: HelloController): new (leaf: WorkspaceLeaf) => ItemView {
	return class WhatsNewView extends ItemView {
		constructor(leaf: WorkspaceLeaf) {
			super(leaf);
			this.navigation = false;
		}

		getViewType(): string {
			return hello.viewType;
		}

		getDisplayText(): string {
			return `What's new in ${hello.pluginName}`;
		}

		getIcon(): string {
			return 'gift';
		}

		async onOpen(): Promise<void> {
			renderWhatsNew(this.contentEl, hello, () => this.leaf.detach());
		}

		async onClose(): Promise<void> {
			this.contentEl.empty();
		}
	};
}

/** Adds one external link. Obsidian opens external links in the system browser on desktop and mobile. */
function link(parent: HTMLElement, text: string, href: string): HTMLAnchorElement {
	return parent.createEl('a', { text, href, cls: 'external-link', attr: { target: '_blank', rel: 'noopener' } });
}

/** Draws the tab content into el. Shows only bundled text. The only links go to notemods.com. */
export function renderWhatsNew(el: HTMLElement, hello: HelloController, close: () => void): void {
	el.empty();
	el.addClass(HELLO_CLS);
	const c = hello.content;
	const name = hello.pluginName;
	const page = el.createDiv({ cls: ['markdown-rendered', `${HELLO_CLS}-page`] });
	page.createEl('h1', { text: `Thanks for updating ${name}` });
	// The change lines can come from an earlier version (a release without user-facing changes), so the subtitle
	// names the installed version only and never says that the list below belongs to it.
	page.createEl('p', {
		cls: `${HELLO_CLS}-sub`,
		text: `You now have version ${hello.version}. This tab opens only after a minor or major update.`,
	});
	if (c?.changes.length) {
		page.createEl('h2', { text: 'Recent changes' });
		const ul = page.createEl('ul', { cls: `${HELLO_CLS}-changes` });
		for (const line of c.changes) ul.createEl('li', { text: line });
	}
	// The tip is its own short block under the changes. The first hello release always has a change line (Send
	// feedback), so a tip shown only without change lines never showed.
	if (c?.tip) {
		page.createEl('h2', { text: 'Did you know' });
		page.createEl('p', { cls: `${HELLO_CLS}-tip`, text: c.tip });
	}
	if (c?.thanks) {
		page.createEl('h2', { text: 'From the maker' });
		page.createEl('p', { text: c.thanks });
	}
	if (c?.related.length) {
		page.createEl('h2', { text: `More from ${HELLO_BRAND}` });
		const rl = page.createEl('ul', { cls: `${HELLO_CLS}-related` });
		for (const r of c.related) {
			const li = rl.createEl('li');
			link(li, r.name, pluginPageUrl(r.id));
			if (r.blurb) li.createSpan({ cls: `${HELLO_CLS}-blurb`, text: ` ${r.blurb}` });
		}
	}
	// Both buttons open notemods.com/hello. The page, not the plugin, offers GitHub issues or the chat.
	new Setting(page)
		.setClass(`${HELLO_CLS}-buttons`)
		.addButton((b) => b.setButtonText('Send feedback').setCta().onClick(() => hello.openFeedback()))
		.addButton((b) => b.setButtonText(`${HELLO_CHAT_NAME} and more plugins`).onClick(() => hello.openChat()))
		.addButton((b) => b.setButtonText('Close').onClick(close));
	new Setting(page)
		.setName("Show what's new after updates")
		.setDesc(`${HELLO_TOGGLE_OFF} The same switch is in the plugin settings.`)
		.addToggle((t) => t.setValue(hello.enabled).onChange((v) => void hello.setEnabled(v)));
}

let current: HelloController | null = null;

/** Runs fn and returns its value, or null when it throws (storage can be blocked). */
function safely<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when the raw key value on disk already holds this state, so a write would change nothing. */
function sameState(raw: unknown, state: HelloState): boolean {
	const disk = raw === undefined || raw === null ? null : readHelloState(raw);
	if (!disk) return raw === undefined && state.lastVersion === HELLO_DEFAULT_STATE.lastVersion && state.show === HELLO_DEFAULT_STATE.show;
	return disk.lastVersion === state.lastVersion && disk.show === state.show;
}

type Write = 'same' | 'written' | 'not-object';

/** The controller that setupHello made for this plugin, or null before onload and after unload. */
export function currentHello(): HelloController | null {
	return current;
}

type Early = { ok: true; data: unknown } | { ok: false };

/**
 * Owns the saved state, the view type and the once-per-update check of one plugin.
 *
 * The state lives in the plugin's own data.json under HELLO_DATA_KEY, so it travels with the plugin settings
 * (Obsidian Sync, iCloud, git). Product settings code drops unknown keys and saves its whole settings object, so
 * setupHello wraps plugin.saveData: every product save gets the key added back, and all writes (product and hello)
 * of this instance run one after the other.
 *
 * An earlier instance of the same plugin (disable and enable, a module update) has its own queue and can still save.
 * So the hello write (1) never runs when data.json already holds the state, (2) waits for the product's first
 * loadData() or for options.after, so it comes after the old instance's last save when the product waits for that
 * save before it reads, and (3) reads data.json again in the queue just before it writes and changes only its key.
 */
export class HelloController {
	readonly viewType: string;
	readonly content: HelloContent | null;
	readonly pluginName: string;
	readonly version: string;
	readonly pluginId: string;
	/** Resolves after the start check, with the decision (null when the plugin unloaded first or the check failed). */
	readonly ready: Promise<HelloDecision | null>;
	private state: HelloState = { ...HELLO_DEFAULT_STATE };
	/** False until the start check: until then a product save keeps the key value that was on disk. */
	private started = false;
	/** The raw key value from data.json at start (undefined when there was none). */
	private carried: unknown = undefined;
	/** The setting value when the user changed it before the start check ran. */
	private toggled: boolean | null = null;
	private unloaded = false;
	private queue: Promise<unknown> = Promise.resolve();
	/** Resolves when the product's first loadData() call settled. */
	private readonly productRead: Promise<void>;
	private readonly after: (() => unknown) | null;
	private readonly loadRaw: () => Promise<unknown>;
	private readonly saveRaw: (data: unknown) => Promise<void>;

	constructor(
		private readonly plugin: Plugin,
		rawContent: unknown,
		options: HelloOptions = {},
	) {
		const m = plugin.manifest;
		this.viewType = `${m.id}-whats-new`;
		this.pluginName = m.name;
		this.version = m.version;
		this.pluginId = m.id;
		this.content = normalizeHelloContent(rawContent, m);
		this.loadRaw = plugin.loadData.bind(plugin) as () => Promise<unknown>;
		this.saveRaw = plugin.saveData.bind(plugin) as (data: unknown) => Promise<void>;
		this.after = typeof options.after === 'function' ? options.after : null;
		// Every product save keeps the hello key. Writes run in sequence with the hello writes.
		plugin.saveData = (data: unknown) => this.enqueue(() => this.saveRaw(this.withState(data)));
		// The product's first read marks the point after its own handoff from an earlier instance.
		let productRead!: () => void;
		this.productRead = new Promise<void>((resolve) => (productRead = resolve));
		plugin.loadData = () => {
			const p = this.loadRaw();
			void p.then(productRead, productRead);
			return p;
		};
		// Read now, in the queue, before the product's onload can save its settings; decide later.
		const early = this.enqueue(async (): Promise<Early> => {
			const data = await this.loadRaw();
			this.carried = isRecord(data) ? data[HELLO_DATA_KEY] : undefined;
			return { ok: true, data };
		}).catch((): Early => ({ ok: false }));
		plugin.register(() => {
			this.unloaded = true;
		});
		const View = whatsNewViewClass(this);
		plugin.registerView(this.viewType, (leaf) => new View(leaf));
		if (options.command !== false && this.content) {
			plugin.addCommand({ id: 'show-whats-new', name: "Show what's new", callback: () => void this.open() });
		}
		if (options.feedbackCommand !== false) {
			plugin.addCommand({ id: 'send-feedback', name: 'Send feedback', callback: () => this.openFeedback() });
		}
		this.ready = new Promise<void>((resolve) => plugin.app.workspace.onLayoutReady(() => resolve()))
			.then(() => early)
			.then(async (r) => {
				if (r.ok) await this.productSettled();
				return r;
			})
			.then((r) => this.start(r))
			.catch((e: unknown) => {
				console.warn(`${this.pluginName}: the what's new check failed`, e);
				return null;
			});
	}

	/** notemods.com/hello for this plugin and version. The page, not the plugin, offers chat or GitHub. */
	get pageUrl(): string {
		return helloPageUrl(this.pluginId, this.version);
	}

	/** The feedback part of the hello page for this plugin and version. */
	get feedbackUrl(): string {
		return helloFeedbackUrl(this.pluginId, this.version);
	}

	/** The chat and "more plugins" part of the hello page. */
	get chatUrl(): string {
		return helloChatUrl(this.pluginId, this.version);
	}

	/** Opens the feedback part of the hello page in the browser. The plugin itself sends nothing. */
	openFeedback(): void {
		window.open(this.feedbackUrl, '_blank');
	}

	/** Opens the chat and "more plugins" part of the hello page in the browser. */
	openChat(): void {
		window.open(this.chatUrl, '_blank');
	}

	/** The "Show what's new after updates" setting. */
	get enabled(): boolean {
		return this.state.show;
	}

	async setEnabled(on: boolean): Promise<void> {
		this.state = { ...this.state, show: on };
		this.toggled = on;
		this.started = true;
		await this.save();
	}

	/**
	 * Shows the tab. From the command or the settings card (focus true) it becomes the active tab. The automatic
	 * open after an update (focus false) adds a tab in the background: the note that was active stays active.
	 */
	async open(focus = true): Promise<void> {
		const { workspace } = this.plugin.app;
		const existing = workspace.getLeavesOfType(this.viewType)[0];
		if (existing) {
			if (focus) await workspace.revealLeaf(existing);
			return;
		}
		const before = focus ? null : workspace.getMostRecentLeaf();
		// A new tab, never the active note's leaf. Obsidian can make a new tab active ("Always focus new tabs").
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: this.viewType, active: focus });
		if (focus) await workspace.revealLeaf(leaf);
		else if (before && before !== leaf) workspace.setActiveLeaf(before, { focus: true });
	}

	/** Adds the hello key to a product save. A value that is not an object cannot carry it and is saved as is. */
	private withState(data: unknown): unknown {
		const value = this.started ? { ...this.state } : this.carried;
		if (value === undefined || !isRecord(data)) return data;
		return { ...data, [HELLO_DATA_KEY]: value };
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn, fn);
		this.queue = p.catch(() => undefined);
		return p;
	}

	/** Waits for options.after, else for the product's first loadData() (at most HELLO_PRODUCT_WAIT_MS). Never throws. */
	private async productSettled(): Promise<void> {
		if (this.after) {
			await Promise.resolve()
				.then(() => this.after?.())
				.catch(() => undefined);
			return;
		}
		let timer: number | undefined;
		await Promise.race([this.productRead, new Promise<void>((resolve) => (timer = window.setTimeout(resolve, HELLO_PRODUCT_WAIT_MS)))]);
		window.clearTimeout(timer);
	}

	private async start(r: Early): Promise<HelloDecision | null> {
		if (this.unloaded) return null;
		if (!r.ok) {
			// data.json is there but cannot be read: keep the opt-out safe. No tab and no write (the product decides).
			return { show: false, reason: 'read-error', next: { ...this.state } };
		}
		// priorData comes from the early read, before the product could save its first settings.
		const priorData = r.data !== null && r.data !== undefined;
		const storage = this.plugin.app as unknown as VaultStorage;
		let decision: HelloDecision | null = null;
		let result: Write;
		try {
			// One queue step: read the freshest data.json, decide, and write only when the state changed.
			result = await this.enqueue(async (): Promise<Write> => {
				if (this.unloaded) return 'same';
				const data = await this.loadRaw();
				const saved = isRecord(data) ? data[HELLO_DATA_KEY] : undefined;
				this.carried = saved;
				const lastShown = typeof storage.loadLocalStorage === 'function' ? safely(() => storage.loadLocalStorage?.(HELLO_SHARED_KEY)) : null;
				decision = decideHello({
					saved,
					priorData,
					current: this.version,
					hasContent: this.content !== null,
					lastShown,
					mobile: Platform.isMobile,
				});
				this.state = this.toggled === null ? decision.next : { ...decision.next, show: this.toggled };
				this.started = true;
				// Claim the shared 14-day slot in the same tick as its read, so a second NoteMods plugin that starts now
				// sees it. Without the API there is no shared slot, and each plugin still shows at most once per update.
				const claim = decision.show && typeof storage.saveLocalStorage === 'function';
				if (claim) {
					const mark: HelloLastShown = { ts: Date.now(), pluginId: this.pluginId, version: this.version };
					safely(() => storage.saveLocalStorage?.(HELLO_SHARED_KEY, mark));
				}
				// When the state cannot be saved, no tab opens, so give the slot back to the other plugins.
				const unclaim = () => {
					if (claim) safely(() => storage.saveLocalStorage?.(HELLO_SHARED_KEY, lastShown ?? null));
				};
				const out = await this.writeState(data, saved).catch((e: unknown) => {
					unclaim();
					throw e;
				});
				if (out === 'not-object') unclaim();
				return out;
			});
		} catch (e) {
			// The read or the write failed: the tab stays closed, so it can never open on each start.
			console.warn(`${this.pluginName}: could not save the what's new setting`, e);
			const d = decision as HelloDecision | null;
			return d ? { ...d, show: false } : { show: false, reason: 'read-error', next: { ...this.state } };
		}
		const d = decision as HelloDecision | null;
		if (!d) return null;
		// data.json that is not an object cannot hold the state: no tab, or it would open on each start.
		if (result === 'not-object') return { ...d, show: false };
		if (d.show && !this.unloaded) await this.open(false);
		return d;
	}

	/**
	 * Writes the state on top of data (just read in the same queue step) and changes only the hello key. Writes
	 * nothing when the key already holds the state, or when data is not an object (the product owns that format).
	 */
	private async writeState(data: unknown, raw: unknown): Promise<Write> {
		if (sameState(raw, this.state)) return 'same';
		if (data !== null && data !== undefined && !isRecord(data)) return 'not-object';
		await this.saveRaw({ ...(isRecord(data) ? data : {}), [HELLO_DATA_KEY]: { ...this.state } });
		this.carried = { ...this.state };
		return 'written';
	}

	/** Writes the state into data.json: reads the file again in the write queue and changes only the hello key. */
	private async save(): Promise<boolean> {
		try {
			const out = await this.enqueue(async () => {
				const data = await this.loadRaw();
				return this.writeState(data, isRecord(data) ? data[HELLO_DATA_KEY] : undefined);
			});
			return out !== 'not-object';
		} catch (e) {
			console.warn(`${this.pluginName}: could not save the what's new setting`, e);
			return false;
		}
	}
}

/**
 * Registers the "What's new" tab and the command, and schedules the once-per-update check after layout ready.
 * Call it at the start of Plugin.onload, before the plugin loads or saves its settings. Never awaits disk reads.
 */
export function setupHello(plugin: Plugin, rawContent: unknown, options?: HelloOptions): HelloController {
	const hello = new HelloController(plugin, rawContent, options);
	current = hello;
	plugin.register(() => {
		if (current === hello) current = null;
	});
	return hello;
}

/** The settings rows for a tab that uses display() (Obsidian before 1.13): a heading, the toggle and the links. */
export function renderHelloSettings(containerEl: HTMLElement, hello: HelloController | null = current): void {
	if (!hello) return;
	new Setting(containerEl).setName(`More from ${HELLO_BRAND}`).setHeading();
	new Setting(containerEl)
		.setName("Show what's new after updates")
		.setDesc(HELLO_TOGGLE_DESC)
		.addToggle((t) => t.setValue(hello.enabled).onChange((v) => void hello.setEnabled(v)));
	const s = new Setting(containerEl).setName(HELLO_BRAND).setDesc(helloAboutText());
	appendHelloLinks(s.descEl, hello);
}

/** What the switch does when it is off. The command and the settings button still open the tab. */
export const HELLO_TOGGLE_OFF = 'Turn off to stop the tab opening by itself. The command still opens it.';

/** The description of the settings toggle. */
export const HELLO_TOGGLE_DESC = `After a minor or major update, opens one tab with recent changes in the background. ${HELLO_TOGGLE_OFF}`;

/** One line about NoteMods for the settings card. */
export function helloAboutText(): string {
	return 'Small plugins that each do one job. ';
}

/** The feedback and chat links after the about text. Both go to the hello page, which offers GitHub or the chat. */
export function appendHelloLinks(el: HTMLElement, hello: HelloController): void {
	link(el, 'Send feedback', hello.feedbackUrl);
	el.appendText(' · ');
	link(el, `${HELLO_CHAT_NAME} and more plugins`, hello.chatUrl);
}
