// Polar license keys through the customer-portal endpoints. These need no token and
// "can be safely used on a public client" (Polar OpenAPI 2026-10). Raw spec excerpts:
// research/obsidian-run/raw/i-sell/polar-2026-10-license-keys-excerpt.json
//
// No Polar-Version header on purpose: a pinned version is removed after about nine
// months and then returns 404, which this code would read as "key not found". The
// fields used here (status, expires_at, created_at, activation.id) are the same in 2026-04,
// 2026-10 and 2027-01.
import type { HttpClient, LicenseProvider, Verdict } from './types';
import { isUuid, readNumberTime, record } from './util';

export interface PolarConfig {
	/** Polar organization id (UUID). Required by every customer-portal license call. */
	organizationId: string;
	/** License key benefit id (UUID). Polar rejects keys of other benefits, so one org can sell many plugins. */
	benefitId: string;
	/** Benefit key prefix, if set in Polar (keys look like PREFIX-<UUID>). */
	keyPrefix?: string;
	/** Set true only if the benefit has an activation limit. */
	activations?: boolean;
	/** https://api.polar.sh (default) or https://sandbox-api.polar.sh for tests. */
	apiBase?: string;
}

const UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}';
const ANY_PREFIX = new RegExp(`^(?:[^\\s]{1,40}-)?${UUID}$`, 'i');

export class PolarProvider implements LicenseProvider {
	readonly id = 'polar';
	readonly seller = 'Polar';
	readonly hosts: readonly string[];
	private readonly base: string;

	constructor(private readonly cfg: PolarConfig) {
		this.base = (cfg.apiBase ?? 'https://api.polar.sh').replace(/\/+$/, '');
		this.hosts = [new URL(this.base).host];
	}

	isConfigured(): boolean {
		return isUuid(this.cfg.organizationId) && isUuid(this.cfg.benefitId);
	}

	isWellFormedKey(key: string): boolean {
		if (key.length > 120 || !ANY_PREFIX.test(key)) return false;
		const prefix = (this.cfg.keyPrefix ?? '').trim().toUpperCase();
		return prefix === '' || key.toUpperCase().startsWith(`${prefix}-`);
	}

	usesActivations(): boolean {
		return this.cfg.activations === true;
	}

	async validate(http: HttpClient, key: string, activationId: string): Promise<Verdict> {
		const body: Record<string, string> = { key, organization_id: this.cfg.organizationId, benefit_id: this.cfg.benefitId };
		if (activationId !== '') body.activation_id = activationId;
		const res = await this.post(http, 'validate', body);
		if (res.status === 200) {
			const j = record(res.json);
			if (j.status !== 'granted') return { kind: 'invalid', reason: 'Polar says this key is not active.' };
			return { kind: 'valid', expiresAt: readNumberTime(j.expires_at), activationId, issuedAt: readNumberTime(j.created_at) };
		}
		return this.failure(res.status, res.json);
	}

	async activate(http: HttpClient, key: string, label: string): Promise<Verdict> {
		const res = await this.post(http, 'activate', { key, organization_id: this.cfg.organizationId, label });
		if (res.status === 200) {
			const j = record(res.json);
			const lk = record(j.license_key);
			const id = typeof j.id === 'string' ? j.id : '';
			if (id === '' || lk.status !== 'granted') return { kind: 'invalid', reason: 'Polar says this key is not active.' };
			if (lk.benefit_id !== this.cfg.benefitId) return { kind: 'invalid', reason: 'This key is for another product.' };
			return { kind: 'valid', expiresAt: readNumberTime(lk.expires_at), activationId: id, issuedAt: readNumberTime(lk.created_at) };
		}
		return this.failure(res.status, res.json);
	}

	async deactivate(http: HttpClient, key: string, activationId: string): Promise<void> {
		await this.post(http, 'deactivate', { key, organization_id: this.cfg.organizationId, activation_id: activationId });
	}

	private post(http: HttpClient, action: string, body: Record<string, string>) {
		return http({
			url: `${this.base}/v1/customer-portal/license-keys/${action}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(body),
		});
	}

	/** Only Polar's own typed errors count as a definite "no". Anything else keeps the offline grace. */
	private failure(status: number, json: unknown): Verdict {
		const error = record(json).error;
		if (status === 404 && error === 'ResourceNotFound') {
			return { kind: 'invalid', reason: 'Polar does not accept this key (unknown, revoked, disabled, expired or for another product).' };
		}
		if (status === 403 && error === 'NotPermitted') {
			return { kind: 'invalid', reason: 'Polar refused to activate this key (inactive key or device limit reached). Free a device in the Polar customer portal.' };
		}
		if (status === 429) return { kind: 'error', reason: 'rate limited' };
		return { kind: 'error', reason: `HTTP ${status}` };
	}
}
