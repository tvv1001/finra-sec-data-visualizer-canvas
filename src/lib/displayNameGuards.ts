/**
 * Shared detection for placeholder / generic CRD display names.
 * When a write path would persist one of these, resolve the CRD from Redis/search first.
 */

export type DisplayNameEntity = 'individual' | 'firm' | string;

export function isGenericPersonDisplayName(value: unknown): boolean {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return true;
	if (/^\d{1,10}$/.test(text)) return true;
	if (/^(?:person|individual|node|crd)\s*[:#-]?\s*\d{1,10}$/i.test(text)) return true;
	if (/^person:\d{1,10}$/i.test(text)) return true;
	if (/^node\s+person:\d{1,10}$/i.test(text)) return true;
	if (/^crd\s*#?:?\s*\d{1,10}$/i.test(text)) return true;
	return false;
}

export function isGenericFirmDisplayName(value: unknown): boolean {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return true;
	if (/^\d{1,10}$/.test(text)) return true;
	if (/^(?:firm|node|crd|sec)\s*[:#-]?\s*\d{1,10}$/i.test(text)) return true;
	if (/^firm:\d{1,10}$/i.test(text)) return true;
	if (/^node\s+firm:\d{1,10}$/i.test(text)) return true;
	if (/^sec\s*#?:?\s*8?-?\d+$/i.test(text)) return true;
	return false;
}

export function isGenericDisplayName(value: unknown, entity: DisplayNameEntity = 'individual'): boolean {
	const kind = String(entity || '').toLowerCase();
	if (kind === 'firm') return isGenericFirmDisplayName(value);
	return isGenericPersonDisplayName(value);
}

/** True when `next` should replace `current` because current is generic/empty or next is richer. */
export function preferNonGenericDisplayName(
	current: string | null | undefined,
	next: string | null | undefined,
	entity: DisplayNameEntity = 'individual',
): string {
	const cur = String(current || '').trim();
	const nxt = String(next || '').trim();
	if (!nxt) return cur;
	if (!cur) return nxt;
	const curGeneric = isGenericDisplayName(cur, entity);
	const nxtGeneric = isGenericDisplayName(nxt, entity);
	if (curGeneric && !nxtGeneric) return nxt;
	if (!curGeneric && nxtGeneric) return cur;
	return nxt.length > cur.length ? nxt : cur;
}
