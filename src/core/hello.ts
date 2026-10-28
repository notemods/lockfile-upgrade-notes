// "What's new" after an update: the host-free part. Version compare, the show decision, the saved state and the
// bundled content model. No obsidian import here; packages/hello holds the tab and the settings rows.
// The content is plain JSON that is bundled at build time. Nothing here sends a request or counts users.

/** One plugin that the tab suggests next to this one. */
export interface HelloRelated {
	id: string;
	name: string;
	blurb: string;
}

/**
 * The bundled "What's new" content of one plugin: src/whats-new.json, made by tools/hello-content.mjs from
 * manifest.json, CHANGELOG.md and products/<slug>/hello.json. The tab links only to notemods.com (the hello page
 * offers feedback, GitHub and chat), so the content carries no links.
 */
export interface HelloContent {
	id: string;
	name: string;
	version: string;
	/** Recent change lines (changes_user when the content has it). Can be empty when there is a tip. */
	changes: string[];
	/** One-line feature tip, shown under "Did you know" below the change lines. */
	tip: string;
	thanks: string;
	related: HelloRelated[];
}

/** What the plugin keeps between starts (key HELLO_DATA_KEY in the plugin's data.json). */
export interface HelloState {
	/** The highest plugin version that this vault has run, or null before the first save. */
	lastVersion: string | null;
	/** The "Show what's new after updates" setting. */
	show: boolean;
}

export type HelloReason =
	| 'first-install'
	| 'update'
	| 'update-from-unknown'
	| 'same'
	| 'patch'
	| 'downgrade'
	| 'off'
	| 'recent'
	| 'corrupt'
	| 'bad-version'
	| 'no-content'
	| 'mobile'
	| 'read-error';

/** The last tab that any NoteMods plugin opened in this vault (app.saveLocalStorage, shared by all of them). */
export interface HelloLastShown {
	ts: number;
	pluginId: string;
	version: string;
}

export interface HelloDecision {
	/** True when the tab opens now. */
	show: boolean;
	reason: HelloReason;
	/** The state to save before the tab opens. */
	next: HelloState;
}

export const HELLO_DEFAULT_STATE: HelloState = { lastVersion: null, show: true };
export const HELLO_SITE = 'https://notemods.com/';
/** The vault localStorage key that every NoteMods plugin reads, so users with many plugins see few tabs. */
export const HELLO_SHARED_KEY = 'notemods-hello-last-shown';
/** At most one tab in this many days per vault, across all NoteMods plugins. */
export const HELLO_QUIET_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The key in the plugin's data.json that holds HelloState. Product settings code never uses it. */
export const HELLO_DATA_KEY = 'notemodsHello';
/** Limits keep a bad content file from making a very long tab. */
export const HELLO_LIMITS = { changes: 8, related: 4, text: 400 };

interface ParsedVersion {
	core: [number, number, number];
	pre: (number | string)[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses x.y.z with an optional prerelease and build part (semver 2.0.0). Returns null for anything else. */
export function parseSemver(v: unknown): ParsedVersion | null {
	if (typeof v !== 'string' || v.length > 64) return null;
	const m = SEMVER.exec(v.trim());
	if (!m) return null;
	const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/**
 * Semver precedence of a and b: -1, 0 or 1. Build metadata is ignored and a prerelease is lower than its release
 * (1.2.0-beta.2 < 1.2.0). Returns null when one of them is not a version.
 */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
	const x = parseSemver(a);
	const y = parseSemver(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) {
		const d = x.core[i]! - y.core[i]!;
		if (d !== 0) return d > 0 ? 1 : -1;
	}
	if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		if (typeof p === 'number' && typeof q === 'number') return p > q ? 1 : -1;
		if (typeof p === 'number') return -1;
		if (typeof q === 'number') return 1;
		return p > q ? 1 : -1;
	}
	return 0;
}

/** Reads saved state. Returns null when the value is not a state object (a corrupt or hand-edited file). */
export function readHelloState(raw: unknown): HelloState | null {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const lastVersion = parseSemver(r.lastVersion) ? (r.lastVersion as string).trim() : null;
	const show = typeof r.show === 'boolean' ? r.show : true;
	return { lastVersion, show };
}

export interface HelloInput {
	/** The saved state as read from disk: a string, a parsed value, or undefined when there is no saved state. */
	saved: unknown;
	/**
	 * True when the plugin had saved settings (data.json) before this module first ran. Then the vault ran an older
	 * version of the plugin, without this module, so this start is an update. False on a first install.
	 */
	priorData: boolean;
	/** manifest.version of the running plugin. */
	current: string;
	/** True when the bundled content has at least one change line. */
	hasContent: boolean;
	/** The shared last-shown record as read from vault localStorage (any value; a bad value counts as none). */
	lastShown?: unknown;
	/** The time now in ms. Default Date.now(). */
	now?: number;
	/** True on Obsidian mobile: the tab never opens by itself there (the command and settings card stay). */
	mobile?: boolean;
}

/** Reads the shared last-shown record. Returns null for a missing or bad value. */
export function readLastShown(raw: unknown): HelloLastShown | null {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts <= 0) return null;
	return { ts: r.ts, pluginId: typeof r.pluginId === 'string' ? r.pluginId : '', version: typeof r.version === 'string' ? r.version : '' };
}

/** True when a NoteMods tab opened in this vault less than HELLO_QUIET_DAYS ago. A time far in the future counts as none. */
export function shownRecently(lastShown: unknown, now: number): boolean {
	const l = readLastShown(lastShown);
	if (!l || l.ts > now + DAY_MS) return false;
	return now - l.ts < HELLO_QUIET_DAYS * DAY_MS;
}

/** True when `to` raises the major or the minor number of `from` (x.Y.z or X.y.z). A patch bump is false. */
export function isFeatureBump(from: unknown, to: unknown): boolean {
	const a = parseSemver(from);
	const b = parseSemver(to);
	if (!a || !b) return false;
	return b.core[0] > a.core[0] || (b.core[0] === a.core[0] && b.core[1] > a.core[1]);
}

/** The higher of two versions; a valid version wins over an invalid one. */
function maxVersion(a: string | null, b: string): string | null {
	const c = compareVersions(a, b);
	if (c === null) return parseSemver(b) ? b : parseSemver(a) ? a : null;
	return c >= 0 ? a : b;
}

/**
 * Decides if the "What's new" tab opens on this start. It opens only when the minor or major version went up since
 * the last start, the setting is on, there is content, the app is not mobile, and no NoteMods plugin opened a tab in
 * this vault in the last HELLO_QUIET_DAYS days. A first install, a patch update, the same version, a downgrade, bad versions and corrupt
 * saved state never open it. `next` always records the current version, so the tab opens at most once per update.
 */
export function decideHello(input: HelloInput): HelloDecision {
	const current = typeof input.current === 'string' ? input.current.trim() : '';
	const off = (reason: HelloReason, next: HelloState): HelloDecision => ({ show: false, reason, next });
	if (input.saved === undefined || input.saved === null) {
		const next: HelloState = { lastVersion: parseSemver(current) ? current : null, show: true };
		if (!input.priorData) return off('first-install', next);
		if (!next.lastVersion) return off('bad-version', next);
		if (!input.hasContent) return off('no-content', next);
		// The old version is unknown: only an x.y.0 release is sure to be a minor or major update.
		if (parseSemver(current)!.core[2] !== 0) return off('patch', next);
		if (input.mobile) return off('mobile', next);
		if (shownRecently(input.lastShown, input.now ?? Date.now())) return off('recent', next);
		return { show: true, reason: 'update-from-unknown', next };
	}
	const state = readHelloState(input.saved);
	if (!state) return off('corrupt', { lastVersion: parseSemver(current) ? current : null, show: true });
	const next: HelloState = { lastVersion: maxVersion(state.lastVersion, current), show: state.show };
	const cmp = compareVersions(current, state.lastVersion);
	if (cmp === null) return off('bad-version', next);
	if (cmp === 0) return off('same', next);
	if (cmp < 0) return off('downgrade', next);
	if (!state.show) return off('off', next);
	if (!input.hasContent) return off('no-content', next);
	if (!isFeatureBump(state.lastVersion, current)) return off('patch', next);
	if (input.mobile) return off('mobile', next);
	if (shownRecently(input.lastShown, input.now ?? Date.now())) return off('recent', next);
	return { show: true, reason: 'update', next };
}

const text = (v: unknown, max = HELLO_LIMITS.text): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The URL when it is an absolute https URL without user info, else null. Bundled links only, never a request. */
export function safeHttpsUrl(v: unknown): string | null {
	if (typeof v !== 'string' || v.length > 500) return null;
	try {
		const u = new URL(v);
		if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
		return u.href;
	} catch {
		return null;
	}
}

/** The notemods.com/hello page for one plugin and version. The site, not the plugin, picks chat or GitHub. */
export function helloPageUrl(id: string, version: string, hash = ''): string {
	return `https://notemods.com/hello/?from=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}${hash}`;
}

/** The feedback part of the hello page. The page picks GitHub issues or another route for this plugin. */
export function helloFeedbackUrl(id: string, version: string): string {
	return helloPageUrl(id, version, '#feedback');
}

/** The chat and "more plugins" part of the hello page. The plugin never links to a chat service directly. */
export function helloChatUrl(id: string, version: string): string {
	return helloPageUrl(id, version, '#chat');
}

/** The notemods.com page of one plugin. */
export function pluginPageUrl(id: string): string {
	return `https://notemods.com/plugins/${encodeURIComponent(id)}/`;
}

const lines = (v: unknown): string[] =>
	(Array.isArray(v) ? v : [])
		.map((c) => text(c))
		.filter(Boolean)
		.slice(0, HELLO_LIMITS.changes);

/**
 * Checks bundled content and fills gaps from the manifest. Uses changes_user (curated text) instead of changes when
 * it has a line. Returns null when there is neither a change line nor a tip. Text is trimmed and cut to HELLO_LIMITS.
 */
export function normalizeHelloContent(raw: unknown, manifest: { id: string; name: string; version: string }): HelloContent | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const user = lines(r.changes_user);
	const changes = user.length ? user : lines(r.changes);
	const tip = text(r.tip, 200);
	if (!changes.length && !tip) return null;
	const id = /^[a-z0-9-]+$/.test(text(r.id, 100)) ? text(r.id, 100) : manifest.id;
	const name = text(r.name, 100) || manifest.name;
	const related = (Array.isArray(r.related) ? r.related : [])
		.map((x): HelloRelated | null => {
			if (x === null || typeof x !== 'object') return null;
			const o = x as Record<string, unknown>;
			const rid = text(o.id, 100);
			const rname = text(o.name, 100);
			if (!/^[a-z0-9-]+$/.test(rid) || !rname || rid === id) return null;
			return { id: rid, name: rname, blurb: text(o.blurb, 200) };
		})
		.filter((x): x is HelloRelated => x !== null)
		.slice(0, HELLO_LIMITS.related);
	return {
		id,
		name,
		version: parseSemver(text(r.version, 64)) ? text(r.version, 64) : manifest.version,
		changes,
		tip,
		thanks: text(r.thanks, 600),
		related,
	};
}
