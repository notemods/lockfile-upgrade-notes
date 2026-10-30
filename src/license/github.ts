// GitHub Sponsors as the Pro check, host-free (fetch is injected as HttpClient).
//  - Sign in: OAuth device flow. POST https://github.com/login/device/code, then poll
//    POST https://github.com/login/oauth/access_token. GitHub answers 200 with an "error" field
//    (authorization_pending, slow_down with a new "interval", expired_token, access_denied).
//    Raw excerpts and real responses: research/obsidian-run/raw/pay/.
//  - Check: one GraphQL query to https://api.github.com/graphql with the user's token.
//    user(login).sponsorshipForViewerAsSponsor(activeOnly:false) is the sponsorship from the signed-in
//    user to the seller, active or past, with its tier (field names checked by introspection 2026-10-10).
//  - Policy: Pro for an active monthly sponsorship of at least minMonthlyUsd, or a one-time sponsorship of
//    at least oneTimeUsd paid within oneTimeMonths (0 = lifetime).
//  - GitHub keeps ONE Sponsorship record per sponsor and sponsorable. A one-time buyer who later starts and
//    cancels a monthly tier shows only the ended monthly record. So with oneTimeMonths 0 the check also reads
//    viewer.totalSponsorshipAmountAsSponsorInCents(sponsorableLogins:[seller]) (Int, USD cents, readable by the
//    viewer only). A total of at least oneTimeUsd is lifetime Pro. If that field is null or fails, the
//    record rule above decides alone.
import type { HttpClient } from './types';
import { formBody, readNumberTime, record } from './util';

export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GRAPHQL_URL = 'https://api.github.com/graphql';
export const GITHUB_HOSTS: readonly string[] = ['github.com', 'api.github.com'];
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** read:user covers the viewer's own private sponsorships; it grants no repository access. */
export const DEFAULT_SCOPE = 'read:user';

export interface SponsorsConfig {
	/** Public client id of the seller's OAuth App with device flow on. A placeholder means "no sign in yet". */
	clientId: string;
	/** GitHub login that receives the sponsorship. */
	sponsorLogin: string;
	/** Smallest monthly tier in USD that turns Pro on. */
	minMonthlyUsd: number;
	/** Smallest one-time amount in USD that turns Pro on. 0 = one-time sponsorships do not unlock Pro. */
	oneTimeUsd: number;
	/** How long a one-time sponsorship unlocks Pro, in months. 0 = lifetime. */
	oneTimeMonths: number;
	/** OAuth scope for the token. Default read:user. */
	scope?: string;
	/** Value of metadata_source in the Sponsor URL, so a payment shows where it came from. createGitHubSponsors sets the plugin id. */
	source?: string;
}

const CLIENT_ID_RE = /^(?:Ov2[0-9][A-Za-z0-9]{16}|Iv[0-9]+\.[0-9a-f]{16}|[0-9a-f]{20})$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

export function isConfigured(cfg: SponsorsConfig): boolean {
	return CLIENT_ID_RE.test(cfg.clientId) && LOGIN_RE.test(cfg.sponsorLogin);
}

export function isWellFormedToken(token: string): boolean {
	return TOKEN_RE.test(token);
}

/**
 * The Sponsors profile URL. With cfg.source it adds metadata_source, which GitHub puts in the metadata column of the
 * transaction export. GitHub accepts only letters, digits, dashes and underscores, at most 100 characters per value,
 * and answers 404 for other characters (docs.github.com/en/sponsors, "Viewing your sponsors and sponsorships").
 * When a one-time sponsorship unlocks Pro (cfg.oneTimeUsd > 0) it adds frequency=one-time. Without it GitHub opens the
 * monthly tab, and the one-time tiers stay behind a toggle (checked live 2026-10-30).
 */
export function sponsorUrl(cfg: SponsorsConfig): string {
	const base = `https://github.com/sponsors/${cfg.sponsorLogin}`;
	const source = (cfg.source ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
	const params: string[] = [];
	if (cfg.oneTimeUsd > 0) params.push('frequency=one-time');
	if (/[A-Za-z0-9]/.test(source)) params.push(`metadata_source=${source}`);
	return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

// ---------- device flow ----------

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** ms since epoch when the codes stop working. */
	expiresAt: number;
	intervalMs: number;
}

export type DeviceStart = { kind: 'ok'; code: DeviceCode } | { kind: 'error'; reason: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const posInt = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback);

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

/** Step 1: asks GitHub for a user code. Sends the client id and the scope, nothing else. */
export async function requestDeviceCode(http: HttpClient, cfg: SponsorsConfig, now: number): Promise<DeviceStart> {
	if (!isConfigured(cfg)) return { kind: 'error', reason: 'Sign in with GitHub is not set up in this version yet.' };
	const res = await http({ url: DEVICE_CODE_URL, method: 'POST', headers: FORM_HEADERS, body: formBody({ client_id: cfg.clientId, scope: cfg.scope ?? DEFAULT_SCOPE }) });
	const j = record(res.json);
	const deviceCode = str(j.device_code);
	const userCode = str(j.user_code);
	const uri = str(j.verification_uri);
	if (res.status !== 200 || deviceCode === '' || userCode === '' || !uri.startsWith('https://github.com/')) {
		const err = str(j.error);
		if (err === 'device_flow_disabled') return { kind: 'error', reason: 'GitHub says device sign in is turned off for this app.' };
		if (res.status === 429 || res.status === 403) return { kind: 'error', reason: 'GitHub is rate limiting sign in. Try again in a few minutes.' };
		return { kind: 'error', reason: `GitHub did not start the sign in (HTTP ${res.status}${err ? `, ${err}` : ''}).` };
	}
	const code: DeviceCode = {
		deviceCode,
		userCode,
		verificationUri: uri,
		expiresAt: now + posInt(j.expires_in, 900) * 1000,
		intervalMs: posInt(j.interval, 5) * 1000,
	};
	return { kind: 'ok', code };
}

export type PollStep =
	| { kind: 'token'; token: string }
	| { kind: 'pending' }
	| { kind: 'slow_down'; intervalMs: number | null }
	| { kind: 'expired' }
	| { kind: 'denied' }
	| { kind: 'error'; reason: string };

/** One poll of the token endpoint. */
export async function pollDeviceToken(http: HttpClient, cfg: SponsorsConfig, deviceCode: string): Promise<PollStep> {
	const res = await http({
		url: ACCESS_TOKEN_URL,
		method: 'POST',
		headers: FORM_HEADERS,
		body: formBody({ client_id: cfg.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT }),
	});
	const j = record(res.json);
	const token = str(j.access_token);
	if (res.status === 200 && isWellFormedToken(token)) return { kind: 'token', token };
	const err = str(j.error);
	if (err === 'authorization_pending') return { kind: 'pending' };
	if (err === 'slow_down') return { kind: 'slow_down', intervalMs: typeof j.interval === 'number' ? posInt(j.interval, 5) * 1000 : null };
	if (err === 'expired_token' || err === 'token_expired') return { kind: 'expired' };
	if (err === 'access_denied') return { kind: 'denied' };
	return { kind: 'error', reason: `GitHub refused the sign in (HTTP ${res.status}${err ? `, ${err}` : ''}).` };
}

export type TokenResult =
	| { kind: 'token'; token: string }
	| { kind: 'expired' }
	| { kind: 'denied' }
	| { kind: 'cancelled' }
	| { kind: 'error'; reason: string };

export interface PollOptions {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	cancelled: () => boolean;
}

/** Most polls one sign in may make: 15 minutes at the 5 second floor is 180. */
const MAX_POLLS = 400;
/** Network failures in a row before polling gives up. */
const MAX_NET_ERRORS = 5;

/** Step 3: polls at the interval GitHub asked for (plus 5 s per slow_down) until a token, a refusal or expiry. */
export async function waitForDeviceToken(http: HttpClient, cfg: SponsorsConfig, code: DeviceCode, opts: PollOptions): Promise<TokenResult> {
	let interval = code.intervalMs;
	let netErrors = 0;
	for (let i = 0; i < MAX_POLLS; i++) {
		await opts.sleep(interval);
		if (opts.cancelled()) return { kind: 'cancelled' };
		if (opts.now() >= code.expiresAt) return { kind: 'expired' };
		let step: PollStep;
		try {
			step = await pollDeviceToken(http, cfg, code.deviceCode);
			netErrors = 0;
		} catch {
			netErrors++;
			if (netErrors >= MAX_NET_ERRORS) return { kind: 'error', reason: 'Could not reach GitHub. Check the connection and sign in again.' };
			continue;
		}
		if (opts.cancelled()) return { kind: 'cancelled' };
		if (step.kind === 'pending') continue;
		if (step.kind === 'slow_down') {
			interval = step.intervalMs ?? interval + 5000;
			continue;
		}
		return step;
	}
	return { kind: 'expired' };
}

// ---------- sponsorship check ----------

export const SPONSOR_QUERY =
	'query($login:String!){viewer{login totalSponsorshipAmountAsSponsorInCents(sponsorableLogins:[$login])}user(login:$login){viewerIsSponsoring sponsorshipForViewerAsSponsor(activeOnly:false){isActive isOneTimePayment createdAt tierSelectedAt tier{name monthlyPriceInCents monthlyPriceInDollars isOneTime isCustomAmount}}}}';

export type NoReason = 'not-sponsoring' | 'ended' | 'below-tier' | 'one-time-below' | 'one-time-expired' | 'one-time-off';

/**
 * - pro: the sponsorship meets the policy. expiresAt is the end of a one-time term (null: no end).
 * - no: a definite answer that this account does not qualify.
 * - signed-out: GitHub no longer accepts the token (401).
 * - error: no definite answer (offline, rate limit, 5xx, odd reply). The offline grace applies.
 */
export type SponsorsVerdict =
	| { kind: 'pro'; login: string; tierName: string; usd: number; oneTime: boolean; expiresAt: number | null }
	| { kind: 'no'; login: string; reason: NoReason; message: string }
	| { kind: 'signed-out'; message: string }
	| { kind: 'error'; reason: string };

/** Adds whole calendar months in UTC. A day past the end of the target month becomes its last day. */
export function addMonths(ms: number, months: number): number {
	const d = new Date(ms);
	const dayOfMonth = d.getUTCDate();
	d.setUTCMonth(d.getUTCMonth() + months);
	if (d.getUTCDate() !== dayOfMonth) d.setUTCDate(0);
	return d.getTime();
}

/** The error reason when a sponsorship record has no tier price (Sponsorship.tier is nullable). */
export const NO_AMOUNT_REASON = 'GitHub did not send the sponsorship amount';

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Applies the policy to one sponsorship record (the GraphQL Sponsorship object). Pure. */
export function judgeSponsorship(s: Record<string, unknown> | null, login: string, cfg: SponsorsConfig, now: number): SponsorsVerdict {
	const no = (reason: NoReason, message: string): SponsorsVerdict => ({ kind: 'no', login, reason, message });
	if (!s) return no('not-sponsoring', `@${login} does not sponsor @${cfg.sponsorLogin} on GitHub.`);
	const tier = record(s.tier);
	// Custom one-time amounts carry their amount in the tier price fields; compare amounts, never tier ids or names.
	const dollars = typeof tier.monthlyPriceInDollars === 'number' && Number.isFinite(tier.monthlyPriceInDollars) ? tier.monthlyPriceInDollars * 100 : null;
	const cents = typeof tier.monthlyPriceInCents === 'number' && Number.isFinite(tier.monthlyPriceInCents) ? tier.monthlyPriceInCents : dollars;
	const amount = (cents ?? 0) / 100;
	const tierName = str(tier.name) || `${usd(amount)}`;
	const oneTime = s.isOneTimePayment === true || tier.isOneTime === true;
	// A record without a price is no answer: the offline grace and the retry apply, never a definite "no".
	const unknownAmount: SponsorsVerdict = { kind: 'error', reason: NO_AMOUNT_REASON };
	if (!oneTime) {
		if (s.isActive !== true) return no('ended', `The monthly sponsorship of @${login} has ended.`);
		if (cents === null) return unknownAmount;
		if (amount < cfg.minMonthlyUsd) return no('below-tier', `@${login} sponsors ${usd(amount)} a month. Pro needs ${usd(cfg.minMonthlyUsd)} a month or more.`);
		return { kind: 'pro', login, tierName, usd: amount, oneTime: false, expiresAt: null };
	}
	if (cfg.oneTimeUsd <= 0) return no('one-time-off', `One-time sponsorships do not turn on Pro here. Pro needs a monthly sponsorship of ${usd(cfg.minMonthlyUsd)} or more.`);
	if (cents === null) return unknownAmount;
	if (amount < cfg.oneTimeUsd) return no('one-time-below', `@${login} sponsored ${usd(amount)} once. Pro needs a one-time sponsorship of ${usd(cfg.oneTimeUsd)} or more.`);
	const paidAt = readNumberTime(s.tierSelectedAt) ?? readNumberTime(s.createdAt);
	if (cfg.oneTimeMonths > 0) {
		if (paidAt === null) return no('one-time-expired', 'GitHub did not say when the one-time sponsorship was made.');
		const end = addMonths(paidAt, cfg.oneTimeMonths);
		if (now >= end) return no('one-time-expired', `The one-time sponsorship of @${login} covered Pro until ${isoDay(end)}.`);
		return { kind: 'pro', login, tierName, usd: amount, oneTime: true, expiresAt: end };
	}
	return { kind: 'pro', login, tierName, usd: amount, oneTime: true, expiresAt: null };
}

export const TOTAL_FIELD = 'totalSponsorshipAmountAsSponsorInCents';

/** True when a GraphQL error is about the total-paid field only (its path ends in that field). */
function isTotalFieldError(e: unknown): boolean {
	const path = record(e).path;
	return Array.isArray(path) && path[path.length - 1] === TOTAL_FIELD;
}

/** The total the viewer has paid to the seller in USD cents, or null when GitHub did not give a number. */
export function readTotalCents(viewer: Record<string, unknown>): number | null {
	const v = viewer[TOTAL_FIELD];
	return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Lifts a "no" to lifetime Pro when the viewer has paid at least oneTimeUsd in total.
 * Only with a lifetime one-time rule (oneTimeUsd > 0, oneTimeMonths 0). Pure.
 */
export function applyTotalPaid(v: SponsorsVerdict, totalCents: number | null, cfg: SponsorsConfig): SponsorsVerdict {
	if (v.kind !== 'no' || totalCents === null) return v;
	if (cfg.oneTimeUsd <= 0 || cfg.oneTimeMonths > 0) return v;
	const total = totalCents / 100;
	if (total < cfg.oneTimeUsd) return v;
	return { kind: 'pro', login: v.login, tierName: `${usd(total)} paid in total`, usd: total, oneTime: true, expiresAt: null };
}

/** Reads a GraphQL reply into a verdict. Pure, so the golden vectors run it on recorded replies. */
export function judgeGraphqlReply(status: number, json: unknown, cfg: SponsorsConfig, now: number): SponsorsVerdict {
	if (status === 401) return { kind: 'signed-out', message: 'GitHub no longer accepts this sign in (it was revoked or expired). Sign in again.' };
	const j = record(json);
	const msg = str(j.message).toLowerCase();
	if (status === 429 || (status === 403 && msg.includes('rate limit'))) return { kind: 'error', reason: 'GitHub rate limit reached' };
	if (status !== 200) return { kind: 'error', reason: `HTTP ${status}` };
	const data = record(j.data);
	const viewer = record(data.viewer);
	const login = str(viewer.login);
	const user = data.user;
	// An error on the total-paid field alone is not fatal: the sponsorship record decides.
	const errors = Array.isArray(j.errors) ? j.errors.filter((e) => !isTotalFieldError(e)) : [];
	// A token without read:user reads viewerIsSponsoring only; every sponsorship field fails with
	// INSUFFICIENT_SCOPES (owner's real device-flow test, 2026-10-10). The fix is a new sign in with read:user.
	if (errors.some((e) => str(record(e).type) === 'INSUFFICIENT_SCOPES')) {
		return { kind: 'signed-out', message: 'This sign in lacks read-only profile access (read:user), which the sponsorship check needs. Sign in again.' };
	}
	// Any other GraphQL error is not a definite "no".
	if (errors.length > 0) {
		const first = str(record(errors[0]).type) || str(record(errors[0]).message);
		return { kind: 'error', reason: `GitHub query error ${first.slice(0, 80)}` };
	}
	if (login === '' || typeof user !== 'object' || user === null) return { kind: 'error', reason: 'unexpected reply from GitHub' };
	const s = (user as Record<string, unknown>).sponsorshipForViewerAsSponsor;
	const verdict = judgeSponsorship(typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : null, login, cfg, now);
	const total = readTotalCents(viewer);
	if (verdict.kind === 'error') {
		// An unknown amount is no answer, but a lifetime total paid still decides.
		const lifted = applyTotalPaid({ kind: 'no', login, reason: 'below-tier', message: '' }, total, cfg);
		return lifted.kind === 'pro' ? lifted : verdict;
	}
	return applyTotalPaid(verdict, total, cfg);
}

/** One request: the sponsorship of the signed-in user to cfg.sponsorLogin. Rejects only on network failure. */
export async function checkSponsorship(http: HttpClient, cfg: SponsorsConfig, token: string, now: () => number): Promise<SponsorsVerdict> {
	const res = await http({
		url: GRAPHQL_URL,
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ query: SPONSOR_QUERY, variables: { login: cfg.sponsorLogin } }),
	});
	return judgeGraphqlReply(res.status, res.json, cfg, now());
}
