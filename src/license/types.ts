// Host-free types. Nothing in this file (or policy/polar/lemonsqueezy) imports obsidian,
// so the policy runs in plain Node tests and in any future host.

/** One HTTP call. The adapter (obsidian.ts) maps this to requestUrl. */
export interface HttpRequest {
	url: string;
	method: 'POST';
	headers: Record<string, string>;
	body: string;
}

/** json is whatever the server sent (parsed), or null when the body was not JSON. */
export interface HttpResponse {
	status: number;
	json: unknown;
}

/** Must resolve for every HTTP status (4xx and 5xx too). Rejects only on network failure. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The answer of one provider call.
 * - valid: the seller says the key is good.
 * - invalid: the seller gave a definite no (unknown, revoked, disabled, expired, other product).
 * - error: no definite answer (offline, timeout, rate limit, 5xx). The offline grace applies.
 * issuedAt is the seller's creation time of the key (Polar ValidatedLicenseKey.created_at, Lemon Squeezy
 * license_key.created_at) when the answer carries it. It anchors a Paid trial once a key exists.
 */
export type Verdict =
	| { kind: 'valid'; expiresAt: number | null; activationId: string; issuedAt?: number | null }
	| { kind: 'invalid'; reason: string; issuedAt?: number | null }
	| { kind: 'error'; reason: string };

export type ProviderId = 'polar' | 'lemonsqueezy';

export interface LicenseProvider {
	readonly id: ProviderId;
	/** Seller name for user-facing text, for example "Polar". */
	readonly seller: string;
	/** Every host this provider sends requests to. The README disclosure and fx check use it. */
	readonly hosts: readonly string[];
	/** False while the product still has placeholder ids: then the plugin sends no request at all. */
	isConfigured(): boolean;
	/** Cheap local check run before any request. */
	isWellFormedKey(key: string): boolean;
	/** True when the seller limits devices, so the first check must activate this device. */
	usesActivations(): boolean;
	validate(http: HttpClient, key: string, activationId: string): Promise<Verdict>;
	activate(http: HttpClient, key: string, label: string): Promise<Verdict>;
	deactivate(http: HttpClient, key: string, activationId: string): Promise<void>;
}

export type LicenseStatus = 'none' | 'malformed' | 'unchecked' | 'valid' | 'invalid';

/** Persisted license state. It never holds customer data (email, name, order). */
export interface LicenseState {
	key: string;
	status: LicenseStatus;
	/** Time of the last definite answer (valid or invalid), ms since epoch. 0 = never. */
	lastAnswerAt: number;
	/** Time of the last valid answer. The 14-day offline grace counts from here. */
	lastValidAt: number;
	/** Time of the last request attempt, successful or not. */
	lastAttemptAt: number;
	/** Seller expiry of the key, or null for a key that does not expire. */
	expiresAt: number | null;
	/** Device activation id from the seller, or "" when activations are off. */
	activationId: string;
	/** Short user-facing status text. Never contains the key. */
	message: string;
	/**
	 * Start of the free trial on this device and vault (Paid listings only), 0 = not started. It lives in local
	 * storage, so clearing storage or opening a new vault starts it again: an offline plugin cannot prevent that.
	 */
	trialStartedAt: number;
	/** Seller creation time of the current key, 0 = unknown. With a key the seller knows, the trial counts from here. */
	keyIssuedAt: number;
}

export interface Decision {
	pro: boolean;
	shouldCheck: boolean;
}
