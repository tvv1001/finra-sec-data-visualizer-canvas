/**
 * Shared "connections filter" tag state used by both the dashboard's
 * Current/Previous Connections filter input (`src/app/dashboard/page.tsx`)
 * and the graph sidebar's "Filter connections…" input (`src/lib/finra-graph.ts`).
 *
 * Persisted to localStorage so the keyword/tags survive navigation (route
 * changes, reloads, switching between the dashboard and the graph page) and
 * are kept in sync across both surfaces (and across browser tabs) via the
 * `storage` event plus an in-page CustomEvent (storage events don't fire in
 * the tab that made the change).
 */

export const FILTER_TAGS_STORAGE_KEY = 'finra_connections_filter_tags';
export const FILTER_TEXT_STORAGE_KEY = 'finra_connections_filter_text';
export const FILTER_ENABLED_STORAGE_KEY = 'finra_connections_filter_enabled';
const FILTER_TAGS_EVENT = 'finra:filter-tags-changed';
const FILTER_TEXT_EVENT = 'finra:filter-text-changed';
const FILTER_ENABLED_EVENT = 'finra:filter-enabled-changed';

function hasWindow(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/\s+/g, ' ');
}

export function getFilterTags(): string[] {
	if (!hasWindow()) return [];
	try {
		const raw = window.localStorage.getItem(FILTER_TAGS_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
	} catch {
		return [];
	}
}

export function setFilterTags(tags: string[]): string[] {
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		const tag = normalizeTag(raw);
		if (!tag) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(tag);
	}
	if (hasWindow()) {
		try {
			window.localStorage.setItem(FILTER_TAGS_STORAGE_KEY, JSON.stringify(deduped));
			window.dispatchEvent(new CustomEvent(FILTER_TAGS_EVENT, { detail: deduped }));
		} catch {
			// ignore localStorage/CustomEvent errors (e.g. private browsing quota)
		}
	}
	return deduped;
}

export function addFilterTag(tag: string): string[] {
	return setFilterTags([...getFilterTags(), tag]);
}

export function removeFilterTag(tag: string): string[] {
	const key = tag.trim().toLowerCase();
	return setFilterTags(getFilterTags().filter((t) => t.toLowerCase() !== key));
}

export function clearFilterTags(): string[] {
	return setFilterTags([]);
}

export function getFilterText(): string {
	if (!hasWindow()) return '';
	try {
		return window.localStorage.getItem(FILTER_TEXT_STORAGE_KEY) || '';
	} catch {
		return '';
	}
}

export function setFilterText(text: string): void {
	if (!hasWindow()) return;
	try {
		if (text) window.localStorage.setItem(FILTER_TEXT_STORAGE_KEY, text);
		else window.localStorage.removeItem(FILTER_TEXT_STORAGE_KEY);
		window.dispatchEvent(new CustomEvent(FILTER_TEXT_EVENT, { detail: text }));
	} catch {
		// ignore
	}
}

/** Subscribes to changes in the committed filter tags (from this tab or others). Returns an unsubscribe fn. */
export function subscribeFilterTags(cb: (tags: string[]) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<string[]>).detail ?? getFilterTags());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_TAGS_STORAGE_KEY) cb(getFilterTags());
	};
	window.addEventListener(FILTER_TAGS_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_TAGS_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

export function getFilterEnabled(): boolean {
	if (!hasWindow()) return true;
	try {
		const raw = window.localStorage.getItem(FILTER_ENABLED_STORAGE_KEY);
		if (raw == null) return true;
		return raw !== '0' && raw !== 'false';
	} catch {
		return true;
	}
}

export function setFilterEnabled(enabled: boolean): boolean {
	if (hasWindow()) {
		try {
			window.localStorage.setItem(FILTER_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
			window.dispatchEvent(new CustomEvent(FILTER_ENABLED_EVENT, { detail: enabled }));
		} catch {
			// ignore localStorage/CustomEvent errors (e.g. private browsing quota)
		}
	}
	return enabled;
}

/** Subscribes to the tags on/off toggle. Returns an unsubscribe fn. */
export function subscribeFilterEnabled(cb: (enabled: boolean) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<boolean>).detail ?? getFilterEnabled());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_ENABLED_STORAGE_KEY) cb(getFilterEnabled());
	};
	window.addEventListener(FILTER_ENABLED_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_ENABLED_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

/** Subscribes to changes in the live (uncommitted) filter text. Returns an unsubscribe fn. */
export function subscribeFilterText(cb: (text: string) => void): () => void {
	if (!hasWindow()) return () => {};
	const onCustom = (ev: Event) => cb((ev as CustomEvent<string>).detail ?? getFilterText());
	const onStorage = (ev: StorageEvent) => {
		if (ev.key === FILTER_TEXT_STORAGE_KEY) cb(getFilterText());
	};
	window.addEventListener(FILTER_TEXT_EVENT, onCustom as EventListener);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(FILTER_TEXT_EVENT, onCustom as EventListener);
		window.removeEventListener('storage', onStorage);
	};
}

/** Split a filter phrase into tokens. Multi-word phrases require every token (AND). */
export function tokenizeFilterPhrase(phrase: string): string[] {
	return String(phrase || '')
		.toLowerCase()
		.split(/[^a-z0-9#]+/i)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

/** True when every token appears somewhere in haystack (order-independent). */
export function haystackMatchesAllTokens(haystack: string, tokens: string[]): boolean {
	if (!tokens.length) return true;
	const lower = haystack.toLowerCase();
	return tokens.every((token) => lower.includes(token));
}

function normalizeFilterPhrase(value: string): string {
	return String(value || '')
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function haystackMatchesExactTag(normalizedHaystack: string, tag: string): boolean {
	const normalizedTag = normalizeFilterPhrase(tag);
	if (!normalizedTag) return true;
	return normalizedHaystack.includes(normalizedTag);
}

/**
 * True if `haystack` matches the filter:
 * - live text keeps the existing token-based AND logic so queries like "timothy dale" match a name in either order.
 * - committed tags are treated as ordered phrase matches so "timothy d" matches "Timothy Dale" while "smith dale" does not.
 * - when live text is non-empty, it is the active query (committed tags do not AND-block it).
 *   Leftover tags in localStorage were causing "1085996" / "timothy dale" to return no rows.
 * - when live text is empty, tags are OR'd (any tag may match)
 */
export function matchesFilterTags(haystack: string, tags: string[], liveText?: string): boolean {
	const lower = haystack.toLowerCase();
	const liveTokens = tokenizeFilterPhrase(liveText || '');
	if (liveTokens.length) {
		return haystackMatchesAllTokens(lower, liveTokens);
	}
	if (tags.length > 0) {
		const normalizedHaystack = normalizeFilterPhrase(haystack);
		return tags.some((tag) => haystackMatchesExactTag(normalizedHaystack, tag));
	}
	return true;
}

/** Higher score = better match for sorting filtered connection cards. */
export function scoreConnectionFilterMatch(haystack: string, tags: string[], liveText?: string): number {
	const lower = haystack.toLowerCase();
	const live = String(liveText || '').trim().toLowerCase();
	const liveTokens = tokenizeFilterPhrase(live);
	let score = 0;
	if (live && lower.includes(live)) score += 50;
	for (const token of liveTokens) {
		if (lower.includes(token)) score += 10;
	}
	// Prefer CRD / exact id hits
	if (/^\d{1,10}$/.test(live) && lower.includes(live)) score += 100;

	if (!tags.length) return score;

	// Tags-only ranking: avoid re-normalizing the haystack per tag token loop.
	const normalizedHaystack = normalizeFilterPhrase(haystack);
	for (const tag of tags) {
		const normalizedTag = normalizeFilterPhrase(tag);
		if (!normalizedTag) continue;
		if (normalizedHaystack.includes(normalizedTag)) score += 40;
		else {
			for (const token of tokenizeFilterPhrase(tag)) {
				if (lower.includes(token)) score += 8;
			}
		}
	}
	return score;
}

/** Empty focused input previews the full list. After the first typed character, tags + live
 * text apply again. After Enter commits a tag, stay filtered even if the input is still focused. */
export function shouldPreviewUnfilteredConnections(opts: {
	focused?: boolean;
	liveText?: string;
	justCommitted?: boolean;
}): boolean {
	if (opts.justCommitted) return false;
	if (!opts.focused) return false;
	return !(opts.liveText || '').trim();
}

/**
 * `enabled` gates committed tags only. Live text always filters when present so users can
 * type a CRD/name even with the Tags checkbox off. Empty-focus preview still shows everyone.
 */
export function matchesConnectionsFilter(
	haystack: string,
	tags: string[],
	liveText?: string,
	enabled = true,
	previewUnfiltered = false,
): boolean {
	if (previewUnfiltered) return true;
	const effectiveTags = enabled ? tags : [];
	const hasLive = Boolean(String(liveText || '').trim());
	if (!enabled && !hasLive) return true;
	return matchesFilterTags(haystack, effectiveTags, liveText);
}

/**
 * Keep all items visible: matched first, unmatched after.
 * Used by dashboard firm connections so keyword tags reorder instead of hide.
 */
export function partitionConnectionsByFilter<T>(
	items: T[],
	getHaystack: (item: T) => string,
	tags: string[],
	liveText?: string,
	enabled = true,
	previewUnfiltered = false,
): { matched: T[]; unmatched: T[]; ordered: T[]; matchedSet: Set<T> } {
	const matchedEntries: Array<{ item: T; haystack: string; score: number }> = [];
	const unmatched: T[] = [];
	const live = String(liveText || '').trim();
	const hasActiveFilter = enabled && !previewUnfiltered && (tags.length > 0 || Boolean(live));
	// Scoring is only needed to rank when live text can differentiate matches.
	const needsScore = hasActiveFilter && Boolean(live);

	for (const item of Array.isArray(items) ? items : []) {
		const haystack = getHaystack(item);
		if (matchesConnectionsFilter(haystack, tags, liveText, enabled, previewUnfiltered)) {
			matchedEntries.push({
				item,
				haystack,
				score: needsScore ? scoreConnectionFilterMatch(haystack, tags, liveText) : 0,
			});
		} else {
			unmatched.push(item);
		}
	}

	if (needsScore) {
		matchedEntries.sort((a, b) => b.score - a.score);
	}

	const matched = matchedEntries.map(({ item }) => item);
	return { matched, unmatched, ordered: [...matched, ...unmatched], matchedSet: new Set(matched) };
}
