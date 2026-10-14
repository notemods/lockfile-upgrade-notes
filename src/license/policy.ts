// The license policy of Procedure I, as pure functions plus one small state holder.
//  - No key (or a malformed key): no request, ever.
//  - A valid answer is kept for 7 days: no request in that time.
//  - Offline: Pro stays on for 14 days after the last valid answer.
//  - A definite "no" from the seller turns Pro off at once.
//  - isPro() is synchronous and reads only the cached state.
//  - Only Pro actions lock. The policy never touches notes.
//  - Paid trial (honest limit): with no key, the trial clock is device-local (trialStartedAt in local storage).
//    Clearing local storage or opening a new vault starts a new trial, and no offline plugin can prevent that
//    without a server record. Once a key exists and the seller has answered for it (valid or invalid), the trial
//    is bound to the seller: it counts from the key's creation time at the seller (keyIssuedAt), never from the
//    local clock, so re-entering a key after clearing storage starts no new trial. Removing the key returns to
//    the device-local trial. A seller-side trial (a time-limited key or a trial subscription) is the only reset-proof trial.
import type { Decision, HttpClient, LicenseProvider, LicenseState, Verdict } from './types';

export const DAY_MS = 86_400_000;
/** A valid answer is reused for this long before the next request. */
export const CACHE_MS = 7 * DAY_MS;
/** Pro stays on for this long after the last valid answer when the seller cannot be reached. */
export const GRACE_MS = 14 * DAY_MS;
/** After a failed attempt (offline, timeout, 429, 5xx), wait this long before the next automatic one. */
export const RETRY_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * A saved time further than this in the future is not trusted. A clock moved back a few days keeps Pro,
 * but a hand-edited lastValidAt or trialStartedAt years ahead must not unlock Pro offline for ever.
 */
export const FUTURE_SKEW_MS = GRACE_MS;

export function emptyState(): LicenseState {
	return {
		key: '',
		status: 'none',
		lastAnswerAt: 0,
		lastValidAt: 0,
		lastAttemptAt: 0,
		expiresAt: null,
		activationId: '',
		message: '',
		trialStartedAt: 0,
		keyIssuedAt: 0,
	};
}

const STATUSES = new Set(['none', 'malformed', 'unchecked', 'valid', 'invalid']);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Repairs saved state (old, partial or hand-edited) so it can never throw or grant Pro by accident. */
export function normalizeState(saved: unknown): LicenseState {
	const base = emptyState();
	if (saved === null || typeof saved !== 'object') return base;
	const s = saved as Record<string, unknown>;
	const status = typeof s.status === 'string' && STATUSES.has(s.status) ? (s.status as LicenseState['status']) : 'none';
	const key = str(s.key).trim();
	return {
		key,
		status: key === '' ? 'none' : status,
		lastAnswerAt: num(s.lastAnswerAt),
		lastValidAt: num(s.lastValidAt),
		lastAttemptAt: num(s.lastAttemptAt),
		expiresAt: typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt) ? s.expiresAt : null,
		activationId: str(s.activationId),
		message: str(s.message),
		trialStartedAt: num(s.trialStartedAt),
		keyIssuedAt: key === '' ? 0 : num(s.keyIssuedAt),
	};
}

/** True when the seller has given a definite answer for the current key: the trial is then bound to the seller. */
export function trialBoundToSeller(state: LicenseState): boolean {
	return state.key !== '' && (state.status === 'valid' || state.status === 'invalid');
}

/** Paid trial in effect now: device-local without a seller-known key, from the seller's key creation time with one. */
export function trialActive(state: LicenseState, now: number, trialDays: number): boolean {
	const start = trialBoundToSeller(state) ? state.keyIssuedAt : state.trialStartedAt;
	const age = now - start;
	return trialDays > 0 && start > 0 && age >= -FUTURE_SKEW_MS && age < trialDays * DAY_MS;
}

/**
 * The whole policy in one pure function (golden vectors: packages/spec/vectors/license-policy.json).
 * pro: may the plugin run Pro actions now? shouldCheck: should it ask the seller now?
 */
export function licenseDecision(state: LicenseState, now: number, trialDays = 0): Decision {
	const inTrial = trialActive(state, now, trialDays);
	if (state.key === '' || state.status === 'none' || state.status === 'malformed') {
		return { pro: inTrial, shouldCheck: false };
	}
	const retryOk = now - state.lastAttemptAt >= RETRY_MS || now < state.lastAttemptAt;
	if (state.status === 'unchecked') return { pro: inTrial, shouldCheck: retryOk };
	// A definite "no" is final until the user enters a key again or presses "Check now".
	if (state.status === 'invalid') return { pro: inTrial, shouldCheck: false };

	const sinceValid = now - state.lastValidAt;
	const notExpired = state.expiresAt === null || now < state.expiresAt;
	const keyPro = sinceValid <= GRACE_MS && sinceValid >= -FUTURE_SKEW_MS && notExpired;
	const stale = now - state.lastAnswerAt >= CACHE_MS || now < state.lastAnswerAt || !notExpired;
	return { pro: keyPro || inTrial, shouldCheck: stale && retryOk };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const issued = (v: number | null | undefined, old: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : old);

/** Folds one provider answer into the state. Pure. */
export function applyVerdict(state: LicenseState, verdict: Verdict, now: number, seller: string): LicenseState {
	if (verdict.kind === 'valid') {
		return {
			...state,
			keyIssuedAt: issued(verdict.issuedAt, state.keyIssuedAt),
			status: 'valid',
			lastAnswerAt: now,
			lastValidAt: now,
			lastAttemptAt: now,
			expiresAt: verdict.expiresAt,
			activationId: verdict.activationId || state.activationId,
			message: verdict.expiresAt === null ? 'Pro is active.' : `Pro is active until ${day(verdict.expiresAt)}.`,
		};
	}
	if (verdict.kind === 'invalid') {
		return { ...state, status: 'invalid', keyIssuedAt: issued(verdict.issuedAt, state.keyIssuedAt), lastAnswerAt: now, lastAttemptAt: now, activationId: '', message: verdict.reason };
	}
	const graceEnd = state.lastValidAt + GRACE_MS;
	// The key rule of licenseDecision, so the text never promises Pro after the key term ended.
	const keyPro = state.status === 'valid' && now - state.lastValidAt >= -FUTURE_SKEW_MS && now <= graceEnd && (state.expiresAt === null || now < state.expiresAt);
	const tail = keyPro ? ` Pro stays on until ${day(graceEnd)} without a check.` : '';
	return { ...state, lastAttemptAt: now, message: `Could not reach ${seller}: ${verdict.reason}.${tail}` };
}

/** Rejects after ms. requestUrl has no timeout option, so every call goes through this. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error('timeout')), ms);
		work.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error('network'));
			},
		);
	});
}

export interface LicenseStore {
	load(): Promise<unknown>;
	save(state: LicenseState): Promise<void>;
}

export interface LicenseOptions {
	provider: LicenseProvider;
	http: HttpClient;
	store: LicenseStore;
	/** Stable per-device label for seller activations. Must not contain personal data. */
	deviceLabel: () => string;
	now?: () => number;
	timeoutMs?: number;
	/** Paid listings only: days of full access before a key is needed. 0 for Optional payment. */
	trialDays?: number;
}

/** Holds the cached state, decides when to call the seller and persists every change. */
export class LicenseManager {
	private state: LicenseState = emptyState();
	private inflight: Promise<void> | null = null;
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly trialDays: number;

	constructor(private readonly opts: LicenseOptions) {
		this.now = opts.now ?? (() => Date.now());
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.trialDays = opts.trialDays ?? 0;
	}

	/** Loads the cache. Never sends a request. */
	async init(): Promise<void> {
		this.state = normalizeState(await this.opts.store.load());
		if (this.trialDays > 0 && this.state.trialStartedAt === 0) {
			this.state = { ...this.state, trialStartedAt: this.now() };
			await this.opts.store.save(this.state);
		}
	}

	/** Synchronous, from cache only. Safe to call on every command. */
	isPro(): boolean {
		return licenseDecision(this.state, this.now(), this.trialDays).pro;
	}

	inTrial(): boolean {
		return trialActive(this.state, this.now(), this.trialDays);
	}

	getState(): Readonly<LicenseState> {
		return this.state;
	}

	get provider(): LicenseProvider {
		return this.opts.provider;
	}

	/** Checks with the seller only when the policy says so (call on startup and once a day). */
	async refresh(): Promise<void> {
		if (!licenseDecision(this.state, this.now(), this.trialDays).shouldCheck) return;
		await this.check();
	}

	/** User pressed "Check now". Still sends nothing for an empty or malformed key. */
	async checkNow(): Promise<void> {
		if (this.state.key === '' || this.state.status === 'malformed') return;
		await this.check();
	}

	/** Stores a new key and checks it once. An empty string removes the key. */
	async setKey(raw: string): Promise<void> {
		const key = raw.trim();
		if (key === '') return this.clearKey();
		if (key === this.state.key && this.state.status === 'valid') return this.checkNow();
		const fresh = { ...emptyState(), trialStartedAt: this.state.trialStartedAt, key };
		if (!this.opts.provider.isWellFormedKey(key)) {
			this.state = { ...fresh, status: 'malformed', message: 'This does not look like a license key. Copy it again from the receipt.' };
			await this.opts.store.save(this.state);
			return;
		}
		this.state = { ...fresh, status: 'unchecked' };
		await this.opts.store.save(this.state);
		await this.check();
	}

	/** Removes the key. Frees the device slot at the seller when activations are on (best effort). */
	async clearKey(): Promise<void> {
		const { key, activationId } = this.state;
		this.state = { ...emptyState(), trialStartedAt: this.state.trialStartedAt };
		await this.opts.store.save(this.state);
		const p = this.opts.provider;
		if (key !== '' && activationId !== '' && p.isConfigured() && p.isWellFormedKey(key)) {
			try {
				await withTimeout(p.deactivate(this.opts.http, key, activationId), this.timeoutMs);
			} catch {
				// Best effort: the customer can also free the slot in the seller's portal.
			}
		}
	}

	private check(): Promise<void> {
		if (!this.inflight) {
			this.inflight = this.runCheck().finally(() => {
				this.inflight = null;
			});
		}
		return this.inflight;
	}

	private async runCheck(): Promise<void> {
		const p = this.opts.provider;
		const { key, activationId } = this.state;
		// Saved state is not trusted: a malformed key never leaves the device, even if storage says "valid".
		if (!p.isWellFormedKey(key)) {
			this.state = { ...this.state, status: 'malformed', message: 'This does not look like a license key. Copy it again from the receipt.' };
			await this.opts.store.save(this.state);
			return;
		}
		if (!p.isConfigured()) {
			this.state = { ...this.state, message: 'Pro is not on sale yet.' };
			return;
		}
		let verdict: Verdict;
		try {
			const call =
				p.usesActivations() && activationId === ''
					? p.activate(this.opts.http, key, this.opts.deviceLabel())
					: p.validate(this.opts.http, key, activationId);
			verdict = await withTimeout(call, this.timeoutMs);
		} catch (e) {
			verdict = { kind: 'error', reason: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'network error' };
		}
		// The key may have changed while the request ran; drop a stale answer.
		if (this.state.key !== key) return;
		this.state = applyVerdict(this.state, verdict, this.now(), p.seller);
		await this.opts.store.save(this.state);
	}
}
