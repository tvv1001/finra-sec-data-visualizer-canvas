const NODE_ROUTE_BASE = '/node';
const DASHBOARD_ROUTE_BASE = '/dashboard';
const INDIVIDUAL_ROUTE_BASE = `${DASHBOARD_ROUTE_BASE}/individual`;
const FIRM_ROUTE_BASE = `${DASHBOARD_ROUTE_BASE}/firm`;

function splitNodeId(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;
	const separatorIndex = normalizedNodeId.indexOf(':');
	if (separatorIndex < 0) return null;
	const prefix = normalizedNodeId.slice(0, separatorIndex).trim();
	const suffix = normalizedNodeId.slice(separatorIndex + 1).trim();
	if (!prefix || !suffix) return null;
	return { prefix, suffix };
}

function toNodeRouteSlug(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return '';
	const separatorIndex = normalizedNodeId.indexOf(':');
	if (separatorIndex < 0) return encodeURIComponent(normalizedNodeId);
	const prefix = normalizedNodeId.slice(0, separatorIndex).trim();
	const rawSuffix = normalizedNodeId.slice(separatorIndex + 1).trim();
	if (!prefix || !rawSuffix) return encodeURIComponent(normalizedNodeId);
	return `${encodeURIComponent(prefix)}-${encodeURIComponent(rawSuffix)}`;
}

function fromNodeRouteSlug(slug: string) {
	const normalizedSlug = String(slug || '').trim();
	if (!normalizedSlug) return null;

	try {
		const legacyNodeId = decodeURIComponent(normalizedSlug);
		if (legacyNodeId.includes(':')) return legacyNodeId;
	} catch {}

	const separatorIndex = normalizedSlug.indexOf('-');
	if (separatorIndex < 0) {
		try {
			return decodeURIComponent(normalizedSlug);
		} catch {
			return normalizedSlug;
		}
	}

	const encodedPrefix = normalizedSlug.slice(0, separatorIndex).trim();
	const encodedSuffix = normalizedSlug.slice(separatorIndex + 1).trim();
	if (!encodedPrefix || !encodedSuffix) {
		try {
			return decodeURIComponent(normalizedSlug);
		} catch {
			return normalizedSlug;
		}
	}

	try {
		return `${decodeURIComponent(encodedPrefix)}:${decodeURIComponent(encodedSuffix)}`;
	} catch {
		return `${encodedPrefix}:${encodedSuffix}`;
	}
}

export function normalizeNodeRouteId(nodeIdOrSlug: string | null | undefined) {
	const normalizedValue = String(nodeIdOrSlug || '').trim();
	if (!normalizedValue) return null;
	if (normalizedValue.includes(':')) return normalizedValue;
	return fromNodeRouteSlug(normalizedValue);
}

/** Query params that should survive node-to-node navigation and client history updates. */
export const STICKY_PARAMS = ['disable_analytics', 'safe_gpu', 'localApi', 'profile'] as const;

export function getStickySearch(search = typeof window !== 'undefined' ? window.location.search : ''): string {
	const current = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	const sticky = new URLSearchParams();
	for (const key of STICKY_PARAMS) {
		const val = current.get(key);
		if (val !== null) sticky.set(key, val);
	}
	const str = sticky.toString();
	return str ? `?${str}` : '';
}

/** Merge sticky params from `fromSearch` into a target URL (pathname+search+hash or absolute). */
export function applyStickyParamsToUrl(rawUrl: string, fromSearch = typeof window !== 'undefined' ? window.location.search : '', origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'): string {
	try {
		const base = new URL(String(rawUrl || '/'), origin);
		const current = new URLSearchParams(fromSearch.startsWith('?') ? fromSearch.slice(1) : fromSearch);
		for (const key of STICKY_PARAMS) {
			const val = current.get(key);
			if (val !== null) base.searchParams.set(key, val);
		}
		return base.pathname + base.search + base.hash;
	} catch {
		return rawUrl;
	}
}

export function buildNodeRoutePath(nodeId: string | null | undefined) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return '/';
	const parts = splitNodeId(normalizedNodeId);
	if (parts?.prefix === 'person') return `/individual/${encodeURIComponent(parts.suffix)}`;
	if (parts?.prefix === 'firm') return `/firm/${encodeURIComponent(parts.suffix)}`;
	if (parts?.prefix === 'entity') return `/entity/${encodeURIComponent(parts.suffix)}`;
	return `${NODE_ROUTE_BASE}/${toNodeRouteSlug(normalizedNodeId)}`;
}

export function buildNodeRouteHref(nodeId: string | null | undefined, search = '') {
	return buildNodeRoutePath(nodeId) + getStickySearch(search || (typeof window !== 'undefined' ? window.location.search : ''));
}

export function parseNodeIdFromPathname(pathname: string | null | undefined) {
	const normalizedPathname = String(pathname || '').trim();
	if (!normalizedPathname || normalizedPathname === '/') return null;

	const dashboardIndividualMatch = /^\/dashboard\/individual\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (dashboardIndividualMatch) {
		try {
			return `person:${decodeURIComponent(dashboardIndividualMatch[1])}`;
		} catch {
			return `person:${dashboardIndividualMatch[1]}`;
		}
	}

	const dashboardFirmMatch = /^\/dashboard\/firm\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (dashboardFirmMatch) {
		try {
			return `firm:${decodeURIComponent(dashboardFirmMatch[1])}`;
		} catch {
			return `firm:${dashboardFirmMatch[1]}`;
		}
	}

	const individualMatch = /^\/individual\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (individualMatch) {
		try {
			return `person:${decodeURIComponent(individualMatch[1])}`;
		} catch {
			return `person:${individualMatch[1]}`;
		}
	}

	const firmMatch = /^\/firm\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (firmMatch) {
		try {
			return `firm:${decodeURIComponent(firmMatch[1])}`;
		} catch {
			return `firm:${firmMatch[1]}`;
		}
	}

	const entityMatch = /^\/entity\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (entityMatch) {
		try {
			return `entity:${decodeURIComponent(entityMatch[1])}`;
		} catch {
			return `entity:${entityMatch[1]}`;
		}
	}

	const legacyMatch = /^\/node\/([^/]+?)\/?$/.exec(normalizedPathname);
	if (!legacyMatch) return null;
	return normalizeNodeRouteId(legacyMatch[1]);
}
