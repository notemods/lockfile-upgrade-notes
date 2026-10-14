// Lemon Squeezy License API (second adapter). No API key needed; form-encoded POSTs;
// 60 requests per minute. Raw doc excerpts: research/obsidian-run/raw/i-sell/lemonsqueezy-license-api-excerpt.json
//
// The License API does not scope a key to a store. Any Lemon Squeezy key from any
// store validates, so this adapter checks meta.store_id and meta.product_id itself.
// The response also carries the customer name and email: they are read past, never stored.
import type { HttpClient, LicenseProvider, Verdict } from './types';
import { formBody, readNumberTime, record } from './util';

export interface LemonSqueezyConfig {
	storeId: number;
	productId: number;
	/** Set true only if the product has an activation limit. */
	activations?: boolean;
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set(['active', 'inactive']);

export class LemonSqueezyProvider implements LicenseProvider {
	readonly id = 'lemonsqueezy';
	readonly seller = 'Lemon Squeezy';
	readonly hosts: readonly string[] = ['api.lemonsqueezy.com'];

	constructor(private readonly cfg: LemonSqueezyConfig) {}

	isConfigured(): boolean {
		return Number.isInteger(this.cfg.storeId) && this.cfg.storeId > 0 && Number.isInteger(this.cfg.productId) && this.cfg.productId > 0;
	}

	isWellFormedKey(key: string): boolean {
		return KEY_RE.test(key);
	}

	usesActivations(): boolean {
		return this.cfg.activations === true;
	}

	async validate(http: HttpClient, key: string, activationId: string): Promise<Verdict> {
		const fields: Record<string, string> = { license_key: key };
		if (activationId !== '') fields.instance_id = activationId;
		const res = await this.post(http, 'validate', fields);
		const j = record(res.json);
		if (typeof j.valid !== 'boolean') return this.transport(res.status);
		return this.judge(j, j.valid, activationId);
	}

	async activate(http: HttpClient, key: string, label: string): Promise<Verdict> {
		const res = await this.post(http, 'activate', { license_key: key, instance_name: label });
		const j = record(res.json);
		if (typeof j.activated !== 'boolean') return this.transport(res.status);
		const id = record(j.instance).id;
		return this.judge(j, j.activated, typeof id === 'string' ? id : '');
	}

	async deactivate(http: HttpClient, key: string, activationId: string): Promise<void> {
		await this.post(http, 'deactivate', { license_key: key, instance_id: activationId });
	}

	private post(http: HttpClient, action: string, fields: Record<string, string>) {
		return http({
			url: `https://api.lemonsqueezy.com/v1/licenses/${action}`,
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formBody(fields),
		});
	}

	private judge(j: Record<string, unknown>, ok: boolean, activationId: string): Verdict {
		const meta = record(j.meta);
		const lk = record(j.license_key);
		const issuedAt = readNumberTime(lk.created_at);
		if (!ok) return { kind: 'invalid', reason: 'Lemon Squeezy does not accept this key.', issuedAt };
		if (meta.store_id !== this.cfg.storeId || meta.product_id !== this.cfg.productId) {
			return { kind: 'invalid', reason: 'This key is for another product.' };
		}
		if (typeof lk.status !== 'string' || !LIVE.has(lk.status)) {
			return { kind: 'invalid', reason: 'Lemon Squeezy says this key is expired or disabled.', issuedAt };
		}
		return { kind: 'valid', expiresAt: readNumberTime(lk.expires_at), activationId, issuedAt };
	}

	private transport(status: number): Verdict {
		return { kind: 'error', reason: status === 429 ? 'rate limited' : `HTTP ${status}` };
	}
}
