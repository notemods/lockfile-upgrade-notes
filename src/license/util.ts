// Small helpers shared by the providers. Pure.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): boolean {
	return typeof v === 'string' && UUID_RE.test(v);
}

/** Treats anything that is not a plain object as an empty object, so field reads never throw. */
export function record(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** ISO date string to ms since epoch; null for null, missing or unparsable values. */
export function readNumberTime(v: unknown): number | null {
	if (typeof v !== 'string') return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

/** application/x-www-form-urlencoded body. */
export function formBody(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');
}
