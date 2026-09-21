'use client';

const DISABLE_FLAG_KEY = 'disable_analytics';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years

let checkPromise: Promise<boolean> | null = null;

function readCookieOptOut(): boolean {
	if (typeof document === 'undefined') return false;
	return document.cookie
		.split(';')
		.map((part) => part.trim())
		.some((part) => part === `${DISABLE_FLAG_KEY}=1`);
}

function readLocalOptOut(): boolean {
	try {
		return window.localStorage.getItem(DISABLE_FLAG_KEY) === '1';
	} catch {
		return false;
	}
}

/**
 * Persists the opt-out as a long-lived (2 year) first-party cookie so it survives
 * across browser profiles/storage clears more reliably than localStorage alone,
 * plus a localStorage flag as a fallback for older code paths.
 */
export function persistAnalyticsOptOut() {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(DISABLE_FLAG_KEY, '1');
	} catch {
		// ignore storage failures (private browsing, quota, etc.)
	}
	try {
		const secure = window.location.protocol === 'https:' ? '; Secure' : '';
		document.cookie = `${DISABLE_FLAG_KEY}=1; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
	} catch {
		// ignore cookie write failures
	}
}

/**
 * Resolves whether analytics should be disabled for the current visitor.
 * Fast path: an existing `disable_analytics` cookie or localStorage flag — set once,
 * automatically, via `?disable_analytics=1` on this machine's browser, after which it
 * persists indefinitely (2 years) with no further checks needed.
 * Optional slow path: if `ANALYTICS_EXCLUDED_IPS` is configured server-side, also asks
 * a server-side endpoint whether the visitor's public IP matches that allowlist, and
 * persists the flag automatically if so.
 */
export function isAnalyticsExcluded(): Promise<boolean> {
	if (typeof window === 'undefined') {
		return Promise.resolve(false);
	}

	if (readCookieOptOut() || readLocalOptOut()) {
		return Promise.resolve(true);
	}

	if (!checkPromise) {
		checkPromise = fetch('/api/analytics/exclude-check', { cache: 'no-store' })
			.then((res) => (res.ok ? res.json() : { excluded: false }))
			.then((data: { excluded?: boolean }) => {
				if (data?.excluded) {
					persistAnalyticsOptOut();
					return true;
				}
				return false;
			})
			.catch(() => false);
	}

	return checkPromise;
}
