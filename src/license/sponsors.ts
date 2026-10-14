// GitHub Sponsors Pro state: the same cache and grace rules as the license key policy (policy.ts).
//  - Not signed in (no token): no request, ever. Pro is off.
//  - A "Pro" answer is kept for 7 days: no request in that time.
//  - Offline, rate limited or 5xx: Pro stays on for 14 days after the last "Pro" answer.
//  - A definite "no" (not sponsoring, below the tier, ended, one-time term over) turns Pro off at once
//    and stays until the user presses Refresh or signs in again.
//  - 401 from GitHub: the token is deleted and the user is signed out.
//  - The token lives only in the TokenStore (Obsidian SecretStorage). The saved state never holds it.
import { CACHE_MS, DEFAULT_TIMEOUT_MS, FUTURE_SKEW_MS, GRACE_MS, RETRY_MS, withTimeout } from './policy';
import {
	checkSponsorship,
	isConfigured,
	isWellFormedToken,
	requestDeviceCode,
	waitForDeviceToken,
	type DeviceCode,
	type DeviceStart,
	type NoReason,
	type SponsorsConfig,
	type SponsorsVerdict,
	type TokenResult,
} from './github';
import type { Decision, HttpClient } from './types';

export type SponsorsStatus = 'signed-out' | 'unchecked' | 'pro' | 'no';

/** Saved Pro state. It holds the GitHub login and tier, never the token. */
export interface SponsorsState {
	status: SponsorsStatus;
	login: string;
	tierName: string;
	usd: number;
	oneTime: boolean;
	/** End of a one-time term, or null. */
	expiresAt: number | null;
	reason: NoReason | '';
	/** Time of the last definite answer (pro or no). */
	lastAnswerAt: number;
	/** Time of the last "pro" answer. The 14-day offline grace counts from here. */
	lastValidAt: number;
	lastAttemptAt: number;
	/** Short user-facing text. Never contains the token. */
	message: string;
}

export function emptySponsorsState(): SponsorsState {
	return { status: 'signed-out', login: '', tierName: '', usd: 0, oneTime: false, expiresAt: null, reason: '', lastAnswerAt: 0, lastValidAt: 0, lastAttemptAt: 0, message: '' };
}

const STATUSES = new Set<SponsorsStatus>(['signed-out', 'unchecked', 'pro', 'no']);
const REASONS = new Set<string>(['not-sponsoring', 'ended', 'below-tier', 'one-time-below', 'one-time-expired', 'one-time-off']);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Repairs saved state (old, partial or hand-edited) so it never throws or grants Pro by accident. */
export function normalizeSponsorsState(saved: unknown): SponsorsState {
	const base = emptySponsorsState();
	if (saved === null || typeof saved !== 'object') return base;
	const s = saved as Record<string, unknown>;
	const status = typeof s.status === 'string' && STATUSES.has(s.status as SponsorsStatus) ? (s.status as SponsorsStatus) : 'signed-out';
	return {
		status,
		login: str(s.login, 39),
		tierName: str(s.tierName, 80),
		usd: num(s.usd),
		oneTime: s.oneTime === true,
		expiresAt: typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt) ? s.expiresAt : null,
		reason: typeof s.reason === 'string' && REASONS.has(s.reason) ? (s.reason as NoReason) : '',
		lastAnswerAt: num(s.lastAnswerAt),
		lastValidAt: num(s.lastValidAt),
		lastAttemptAt: num(s.lastAttemptAt),
		message: str(s.message, 300),
	};
}

/**
 * The whole policy in one pure function (golden vectors: packages/spec/vectors/github-sponsors.json).
 * hasToken: a token is in SecretStorage. pro: may Pro features run now? shouldCheck: ask GitHub now?
 */
export function sponsorsDecision(state: SponsorsState, hasToken: boolean, now: number): Decision {
	if (!hasToken || state.status === 'signed-out') return { pro: false, shouldCheck: false };
	const retryOk = now - state.lastAttemptAt >= RETRY_MS || now < state.lastAttemptAt;
	if (state.status === 'unchecked') return { pro: false, shouldCheck: retryOk };
	if (state.status === 'no') return { pro: false, shouldCheck: false };
	const sinceValid = now - state.lastValidAt;
	const notExpired = state.expiresAt === null || now < state.expiresAt;
	const pro = sinceValid <= GRACE_MS && sinceValid >= -FUTURE_SKEW_MS && notExpired;
	const stale = now - state.lastAnswerAt >= CACHE_MS || now < state.lastAnswerAt || !notExpired;
	return { pro, shouldCheck: stale && retryOk };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Folds one GitHub answer into the state. Pure. */
export function applySponsorsVerdict(state: SponsorsState, v: SponsorsVerdict, now: number): SponsorsState {
	if (v.kind === 'pro') {
		const until = v.expiresAt === null ? '' : ` until ${day(v.expiresAt)}`;
		return {
			...state,
			status: 'pro',
			login: v.login,
			tierName: v.tierName,
			usd: v.usd,
			oneTime: v.oneTime,
			expiresAt: v.expiresAt,
			reason: '',
			lastAnswerAt: now,
			lastValidAt: now,
			lastAttemptAt: now,
			message: `Signed in as @${v.login}. Pro is active${until} (${v.tierName}). Checked ${day(now)}.`,
		};
	}
	if (v.kind === 'no') {
		return { ...state, status: 'no', login: v.login, reason: v.reason, expiresAt: null, lastAnswerAt: now, lastAttemptAt: now, message: v.message };
	}
	if (v.kind === 'signed-out') return { ...emptySponsorsState(), message: v.message };
	const graceEnd = state.lastValidAt + GRACE_MS;
	// The same rule as isPro(), so the text never promises Pro after a one-time term ended.
	const tail = sponsorsDecision(state, true, now).pro ? ` Pro stays on until ${day(graceEnd)} without a check.` : '';
	return { ...state, lastAttemptAt: now, message: `Could not reach GitHub: ${v.reason}.${tail}` };
}

/** Where the token lives. Obsidian: app.secretStorage. Never data.json, never the saved state. */
export interface TokenStore {
	get(): string | null;
	set(token: string): void;
	clear(): void;
}

export interface SponsorsStateStore {
	load(): unknown;
	save(state: SponsorsState): void;
}

export interface SponsorsOptions {
	config: SponsorsConfig;
	http: HttpClient;
	tokens: TokenStore;
	store: SponsorsStateStore;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
}

export type SignInResult = TokenResult | { kind: 'checked'; state: SponsorsState };

/** Holds the cached state, runs the device flow and the sponsorship check, persists every change. */
export class SponsorsManager {
	private state: SponsorsState = emptySponsorsState();
	private inflight: Promise<void> | null = null;
	/** The token of the check in flight. */
	private inflightToken: string | null = null;
	private disposed = false;
	private listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly timeoutMs: number;

	constructor(readonly opts: SponsorsOptions) {
		this.now = opts.now ?? (() => Date.now());
		this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => window.setTimeout(r, ms)));
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	get config(): SponsorsConfig {
		return this.opts.config;
	}

	/**
	 * Plugin unload: stops a sign-in poll, sends no more requests, drops answers that arrive later
	 * and calls no listener. createGitHubSponsors registers it with the plugin.
	 */
	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	/** Loads the cache. Never sends a request. A state without a token is a signed-out state. */
	init(): void {
		this.state = normalizeSponsorsState(this.opts.store.load());
		if (!this.hasToken() && this.state.status !== 'signed-out') this.state = { ...emptySponsorsState(), message: this.state.message };
	}

	/** Called after every state change (the plugin re-applies Pro features). Returns an unsubscribe function. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	isConfigured(): boolean {
		return isConfigured(this.opts.config);
	}

	hasToken(): boolean {
		const t = this.opts.tokens.get();
		return typeof t === 'string' && isWellFormedToken(t);
	}

	/** Synchronous, from cache only. */
	isPro(): boolean {
		return sponsorsDecision(this.state, this.hasToken(), this.now()).pro;
	}

	getState(): Readonly<SponsorsState> {
		return this.state;
	}

	/** Checks with GitHub only when the policy says so (startup and once a day). */
	async refresh(): Promise<void> {
		if (!sponsorsDecision(this.state, this.hasToken(), this.now()).shouldCheck) return;
		await this.check();
	}

	/** The Refresh button. Sends nothing when signed out. */
	async refreshNow(): Promise<void> {
		if (!this.hasToken()) return;
		await this.check();
	}

	/** Sign in, step 1: the user code to show. Sends only the client id and the scope to github.com. */
	async startSignIn(): Promise<DeviceStart> {
		if (this.disposed) return { kind: 'error', reason: 'The plugin is not loaded.' };
		try {
			return await withTimeout(requestDeviceCode(this.opts.http, this.opts.config, this.now()), this.timeoutMs);
		} catch {
			return { kind: 'error', reason: 'Could not reach GitHub. Check the connection and try again.' };
		}
	}

	/** Sign in, step 2: waits for the user to enter the code, stores the token, checks the sponsorship once. */
	async finishSignIn(code: DeviceCode, cancelled: () => boolean = () => false): Promise<SignInResult> {
		const timed: HttpClient = (req) => withTimeout(this.opts.http(req), this.timeoutMs);
		const stop = () => this.disposed || cancelled();
		if (stop()) return { kind: 'cancelled' };
		const result = await waitForDeviceToken(timed, this.opts.config, code, { now: this.now, sleep: this.sleep, cancelled: stop });
		if (result.kind !== 'token') return result;
		if (this.disposed) return { kind: 'cancelled' };
		this.opts.tokens.set(result.token);
		this.state = { ...emptySponsorsState(), status: 'unchecked' };
		this.save();
		await this.check();
		return { kind: 'checked', state: this.state };
	}

	/** Deletes the token and the cached answer. Sends nothing. */
	signOut(): void {
		this.opts.tokens.clear();
		this.state = emptySponsorsState();
		this.save();
	}

	private check(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const token = this.opts.tokens.get();
		// A check with an older token drops its answer; check the new token after it ends.
		if (this.inflight && this.inflightToken !== token) return this.inflight.then(() => this.check());
		if (!this.inflight) {
			this.inflightToken = token;
			this.inflight = this.runCheck().finally(() => {
				this.inflight = null;
				this.inflightToken = null;
			});
		}
		return this.inflight;
	}

	private async runCheck(): Promise<void> {
		const token = this.opts.tokens.get();
		if (typeof token !== 'string' || !isWellFormedToken(token)) return;
		// The time before the request: a 6-hour tick then finds the retry due, not a few ms short.
		const startedAt = this.now();
		let verdict: SponsorsVerdict;
		try {
			verdict = await withTimeout(checkSponsorship(this.opts.http, this.opts.config, token, this.now), this.timeoutMs);
		} catch (e) {
			verdict = { kind: 'error', reason: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'network error' };
		}
		// The user may have signed out or in again, or the plugin unloaded, while the request ran; drop a stale answer.
		if (this.disposed || this.opts.tokens.get() !== token) return;
		if (verdict.kind === 'signed-out') this.opts.tokens.clear();
		this.state = applySponsorsVerdict(this.state, verdict, startedAt);
		this.save();
	}

	private save(): void {
		this.opts.store.save(this.state);
		for (const fn of this.listeners) fn();
	}
}
