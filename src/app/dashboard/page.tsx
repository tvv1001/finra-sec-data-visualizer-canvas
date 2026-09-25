'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { buildJsonDisplayTree, coerceStructuredValue, normalizeRenderablePayload, renderJsonForDisplay } from '../../lib/dashboard-json';
import { resolveMainRecordTitle } from '../../lib/dashboard-record-title';
import { getRecordDisplayName } from '../../lib/recordDisplay';
import { formatOtherName, formatUiText } from '@/lib/finra-graph/formatters';
import { buildPersonName, formatEntityName, formatFirmName, formatPersonName } from '@/lib/nameFormat';
import { hasFirmSourceCoverage, hasIndividualSourceCoverage } from '@/lib/sourceTruth';
import {
	buildOrphanIndividualPayloadFromHints,
	extractPayloadFromDetail,
	mergeEmploymentCardsAcrossSources,
	overlayMergedEmploymentHistory,
	resolveEmploymentStatusTag,
	resolveOrderedSourcesFromDetail,
	sortByMostRecentStartDate,
	type DashboardOrphanOwnerHints,
} from '@/lib/dashboard-detail';
import {
	getFilterEnabled,
	getFilterTags,
	getFilterText,
	partitionConnectionsByFilter,
	setFilterEnabled,
	setFilterTags,
	setFilterText,
	shouldPreviewUnfilteredConnections,
	subscribeFilterEnabled,
	subscribeFilterTags,
	subscribeFilterText,
} from '@/lib/filterTags';
import VectorLoader from '@/components/VectorLoader';
import { readQueueGraphBridgePayload, writeQueueGraphBridge, type QueueGraphBridgePerson } from '@/lib/queueGraphBridge';
import {
	readVisited,
	readVisitedSync,
	rememberFirmConnectionsCache,
	rememberVisited,
	visitConnectionsKey,
	visitDetailKey,
	visitSnapshotKey,
	type CachedFirmConnectionsPayload,
} from '@/lib/clientVisitCache';
import styles from './dashboard.module.css';

type DashboardAction = 'fetch-crds' | 'list-new-crds';

// Per-record scroll position memory: keyed by "entity:id". Kept at module scope (not a
// component-local ref) because navigating between the /dashboard, /dashboard/firm/[id], and
// /dashboard/individual/[id] routes unmounts/remounts the shared DashboardPage component, which
// would otherwise wipe out any component-local scroll history on every connection-card click or
// browser back/forward navigation.
const dashboardScrollPositionsByRecord = new Map<string, number>();
let dashboardCurrentScrollRecordKey: string | null = null;
// One-shot: firm → connection → person → reopen same firm scrolls to the connections filter.
// Kept in sessionStorage too so a route remount still sees it.
const FIRM_CONNECTIONS_RETURN_STORAGE_KEY = 'finra_dashboard_connections_return';
const FIRM_CONNECTIONS_ANCHOR_ID = 'dashboard-firm-connections';
/** Sync buffer so Graph can read multi-select results before React localHistory flushes. */
let pendingQueueGraphSeed: {
	nodeIds: string[];
	people: QueueGraphBridgePerson[];
	anchorFirmId?: string;
	anchorFirmName?: string;
} | null = null;
let pendingFirmConnectionsReturnFirmId: string | null = null;
// While set, skip restoring a stale firm scrollTop so the connections anchor can win.
let skipScrollRestoreForKey: string | null = null;

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
	let node = el?.parentElement ?? null;
	while (node && node !== document.body) {
		const style = window.getComputedStyle(node);
		const overflowY = style.overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

function readPendingFirmConnectionsReturn(): string | null {
	if (pendingFirmConnectionsReturnFirmId) return pendingFirmConnectionsReturnFirmId;
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.sessionStorage.getItem(FIRM_CONNECTIONS_RETURN_STORAGE_KEY);
		const firmId = String(raw || '').trim();
		if (!firmId) return null;
		pendingFirmConnectionsReturnFirmId = firmId;
		return firmId;
	} catch {
		return null;
	}
}

function writePendingFirmConnectionsReturn(firmId: string | null) {
	pendingFirmConnectionsReturnFirmId = firmId;
	if (typeof window === 'undefined') return;
	try {
		if (!firmId) window.sessionStorage.removeItem(FIRM_CONNECTIONS_RETURN_STORAGE_KEY);
		else window.sessionStorage.setItem(FIRM_CONNECTIONS_RETURN_STORAGE_KEY, firmId);
	} catch {
		// ignore
	}
}

function persistDashboardScroll(container?: HTMLElement | null) {
	const key = dashboardCurrentScrollRecordKey;
	if (!key || !container) return;
	const top = container.scrollTop;
	// After a Next.js route remount (firm <-> individual), the new pane is empty and
	// reports scrollTop 0. Do not clobber a previously saved position with that.
	if (top <= 0 && container.scrollHeight <= container.clientHeight + 1) return;
	dashboardScrollPositionsByRecord.set(key, top);
}

type DashboardRecordSnapshot = {
	payload: Record<string, any>;
	source: 'finra' | 'sec';
	label: string;
	detectedSources: Array<'finra' | 'sec'>;
	recordName: string;
	updatedAt?: string | null;
};

const DASHBOARD_RECORD_CACHE_MAX = 40;
const CONNECTION_PAGE_SIZE = 80;
/** When a filter is active, paint more matched rows at once so CRD/name hits aren't stuck behind the sentinel. */
const CONNECTION_FILTER_PAGE_SIZE = 240;

function ConnectionsLazySentinel({ rootRef, enabled, page, onLoadMore }: { rootRef: RefObject<HTMLElement | null>; enabled: boolean; page: number; onLoadMore: () => void }) {
	const nodeRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!enabled) return;
		const node = nodeRef.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
			},
			{ root: rootRef.current, rootMargin: '360px 0px', threshold: 0 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [enabled, onLoadMore, page, rootRef]);
	if (!enabled) return null;
	return (
		<div
			ref={nodeRef}
			className={styles.connectionsLazySentinel}
			aria-hidden='true'
		/>
	);
}
const dashboardMergedDetailCache = new Map<string, any>();
const dashboardRecordSnapshotCache = new Map<string, DashboardRecordSnapshot>();

function stripFirmConnectionLists<T>(payload: T): T {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
	const record = payload as Record<string, any>;
	if (!('currentConnections' in record) && !('previousConnections' in record)) return payload;
	const { currentConnections: _current, previousConnections: _previous, ...rest } = record;
	return rest as T;
}

function firmConnectionRosterFrom(value: any): { currentConnections: any[]; previousConnections: any[] } | null {
	const currentConnections = Array.isArray(value?.currentConnections) ? value.currentConnections : [];
	const previousConnections = Array.isArray(value?.previousConnections) ? value.previousConnections : [];
	if (!currentConnections.length && !previousConnections.length) return null;
	return { currentConnections, previousConnections };
}

/** Non-live Form BD people must carry parent firm CRD + name for employment/profile cards. */
function getNonLiveOrphanBody(payload: unknown): Record<string, any> | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const obj = payload as Record<string, any>;
	if (obj.orphan && typeof obj.orphan === 'object') return obj.orphan as Record<string, any>;
	const scope = String(obj.bcScope || '').toLowerCase().replace(/\s+/g, '');
	const source = String(obj.source || '');
	if (source.includes('form-bd') || scope === 'notinscope' || (obj.parentCrd && obj.position && obj.hasFinraData !== true)) {
		return obj;
	}
	return null;
}

function isCompleteNonLiveOrphanPayload(payload: unknown): boolean {
	const orphan = getNonLiveOrphanBody(payload);
	if (!orphan) return true; // not a non-live payload — snapshot OK as-is
	const parentCrd = pickFirstValidCrd(orphan.parentCrd);
	const firmName = String(orphan.firmName || '').trim();
	const name = String(orphan.name || '').trim();
	return Boolean(parentCrd && (firmName || name));
}

function ensureOrphanEnvelope(payload: unknown, crd: string): Record<string, any> {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return { found: true, crd, orphan: null, hasFinraData: false, hasSecData: false };
	}
	const obj = payload as Record<string, any>;
	if (obj.orphan && typeof obj.orphan === 'object') {
		return {
			found: obj.found !== false,
			crd: String(obj.crd || crd),
			orphan: obj.orphan,
			sources: obj.sources || { finra: { found: false }, sec: { found: false } },
			hasFinraData: false,
			hasSecData: false,
		};
	}
	const body = getNonLiveOrphanBody(obj);
	if (body) {
		return {
			found: true,
			crd: String(body.crd || crd),
			orphan: body,
			sources: { finra: { found: false }, sec: { found: false } },
			hasFinraData: false,
			hasSecData: false,
		};
	}
	return obj;
}

function rememberDashboardRecordSnapshot(key: string, snapshot: DashboardRecordSnapshot) {
	const [entity, id] = key.split(':');
	let payloadForCache = entity === 'firm' ? stripFirmConnectionLists(snapshot.payload) : snapshot.payload;
	if (entity === 'individual' && id && getNonLiveOrphanBody(payloadForCache)) {
		payloadForCache = ensureOrphanEnvelope(payloadForCache, id);
	}
	const snapshotForCache = payloadForCache === snapshot.payload ? snapshot : { ...snapshot, payload: payloadForCache };
	dashboardRecordSnapshotCache.delete(key);
	dashboardRecordSnapshotCache.set(key, snapshotForCache);
	while (dashboardRecordSnapshotCache.size > DASHBOARD_RECORD_CACHE_MAX) {
		const oldest = dashboardRecordSnapshotCache.keys().next().value;
		if (oldest == null) break;
		dashboardRecordSnapshotCache.delete(oldest);
	}
	if ((entity === 'firm' || entity === 'individual') && id) {
		rememberVisited(visitSnapshotKey(entity, id), snapshotForCache);
		rememberVisited(visitDetailKey(entity, id), payloadForCache);
		if (entity === 'firm') {
			const roster = firmConnectionRosterFrom(snapshot.payload);
			if (roster) rememberVisited(visitConnectionsKey(id), { found: true, ...roster });
		}
	}
}

type ApiResponse = {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
};

type SearchResult = Record<string, any>;

type SearchResultSource = 'finra' | 'sec';

type SearchResultCard = {
	id: string;
	label: string;
	scope: string;
	address: string;
	detail: string;
	otherNames: string[];
	source: SearchResultSource;
	availableSources?: SearchResultSource[];
	entity: 'individual' | 'firm';
	payload: SearchResult;
};

type QueueCardSourceEntry = {
	source: SearchResultSource;
	status: 'ok' | 'skipped' | 'error' | 'unknown';
	error?: string;
	skipReason?: string;
};

type QueueCard = {
	id: string;
	entity: 'individual' | 'firm';
	files: number;
	sources: QueueCardSourceEntry[];
	since?: string;
	kind?: 'recent';
	name?: string | null;
	statusText?: string | null;
	memberSince?: string | null;
	savedRecordCount?: number;
	updatedExistingRecordCount?: number;
	updatedExistingSourceCount?: number;
	skippedSourceCount?: number;
	trueErrorCount?: number;
	/** Parent-firm Form BD owner metadata for non-live individual deep links. */
	orphanHints?: DashboardOrphanOwnerHints | null;
};

type QueueRunItem = {
	query: string;
	status: 'queued' | 'running' | 'complete' | 'nomatch' | 'error';
	elapsedSec: number;
	message?: string;
	newRec?: number;
	updatedRec?: number;
	errRec?: number;
};

type UrlSelectionInput = {
	entity: 'individual' | 'firm';
	id: string;
	source: SearchResultSource;
	availableSources?: SearchResultSource[];
};

export function parseDashboardSelectionFromUrl(urlString: string): UrlSelectionInput | null {
	try {
		const url = new URL(urlString, 'http://localhost');
		const params = url.searchParams;

		const normalizeSelectionId = (value: unknown) => {
			const text = String(value || '').trim();
			if (!text) return '';
			if (/^\d{1,10}$/.test(text)) return text;
			const extracted = extractNumericCrdsFromText(text)[0] || '';
			if (extracted) return extracted;
			const loose = text.match(/\b(\d{1,10})\b/);
			return loose?.[1] || '';
		};

		const pathMatch = /^\/dashboard\/(individual|firm)\/([^/?#]+)\/?$/i.exec(url.pathname);
		if (pathMatch) {
			const entity: 'individual' | 'firm' = pathMatch[1].toLowerCase() === 'firm' ? 'firm' : 'individual';
			const id = normalizeSelectionId(decodeURIComponent(pathMatch[2]));
			if (!id) return null;

			const sourceParam = String(params.get('source') || '')
				.trim()
				.toLowerCase();
			const source: SearchResultSource = sourceParam === 'sec' ? 'sec' : 'finra';
			const availableSources: SearchResultSource[] = [];
			if (params.get('finra') === '1') availableSources.push('finra');
			if (params.get('sec') === '1') availableSources.push('sec');
			if (!availableSources.includes(source)) availableSources.push(source);

			return {
				entity,
				id,
				source,
				availableSources,
			};
		}

		const firmId = normalizeSelectionId(params.get('CRD_firm'));
		const individualId = normalizeSelectionId(params.get('CRD_individual'));
		const id = firmId || individualId;
		if (!id) return null;

		const sourceParam = String(params.get('source') || '')
			.trim()
			.toLowerCase();
		const source: SearchResultSource = sourceParam === 'sec' ? 'sec' : 'finra';
		const availableSources: SearchResultSource[] = [];
		if (params.get('finra') === '1') availableSources.push('finra');
		if (params.get('sec') === '1') availableSources.push('sec');
		if (!availableSources.includes(source)) availableSources.push(source);

		return {
			entity: firmId ? 'firm' : 'individual',
			id,
			source,
			availableSources,
		};
	} catch {
		return null;
	}
}

function extractNumericCrdsFromText(text: string): string[] {
	const raw = String(text || '').trim();
	if (!raw) return [];

	const directMatches = Array.from(raw.matchAll(/(?:^|[\s:;#-])(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id|id)\s*[:#-]?\s*(\d{1,10})/gi));
	if (directMatches.length) {
		return directMatches.map((match) => match[1]).filter(Boolean);
	}

	const fallbackMatches = Array.from(raw.matchAll(/\b(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id)\b[^0-9]{0,10}(\d{1,10})\b/gi));
	if (fallbackMatches.length) {
		return fallbackMatches.map((match) => match[1]).filter(Boolean);
	}

	return [];
}

function buildGraphHrefForEntity(entity: 'individual' | 'firm' | null | undefined, id: string | null | undefined) {
	const normalizedId = normalizeCrd(id);
	if (!normalizedId) return null;
	if (entity === 'firm') return `/firm/${encodeURIComponent(normalizedId)}`;
	if (entity === 'individual') return `/individual/${encodeURIComponent(normalizedId)}`;
	return null;
}

function getLatestGraphHrefFromHistory(entries: LocalHistoryEntry[]) {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const sorted = entries.slice().sort((left, right) => new Date(right.lastVisitedAt || right.fetchedAt).getTime() - new Date(left.lastVisitedAt || left.fetchedAt).getTime());
	for (const entry of sorted) {
		const href = buildGraphHrefForEntity(entry.entity, entry.id);
		if (href) return href;
	}
	return null;
}

// Builds the graph's `person:<crd>` / `firm:<crd>` node id for a dashboard entity+crd pair.
function buildGraphNodeId(entity: 'individual' | 'firm' | null | undefined, id: string | null | undefined) {
	const normalizedId = normalizeCrd(id);
	if (!normalizedId) return null;
	if (entity === 'firm') return `firm:${normalizedId}`;
	if (entity === 'individual') return `person:${normalizedId}`;
	return null;
}

// Collects the node ids that should be hydrated into the graph's selection log when
// navigating "back to graph" from the dashboard (Queue / selection history).
function collectSelectedNodeIdsForGraphHref(localHistory: LocalHistoryEntry[]) {
	const ids = new Set<string>();
	for (const entry of Array.isArray(localHistory) ? localHistory : []) {
		const nodeId = buildGraphNodeId(entry.entity, entry.id);
		if (nodeId) ids.add(nodeId);
	}
	return Array.from(ids);
}

function parseQueueQueries(input: string) {
	const HEADER_REGEX =
		/^(crd|crd\s*#|crd\s*number|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id|id|crd_number|crd_id|individual_id|firm_id|individual_crd|firm_crd|representative\s*crd|rep\s*crd|name|individual\s*name|firm\s*name|representative\s*name|rep\s*name)$/i;
	const PREFIX_NUMERIC_REGEX = /^(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*crd\s*:|firm\s*crd\s*:)\s*(\d{1,10})$/i;

	const rawTokens = input
		.split(/[\n\r,;\t]+/g)
		.map((value) => value.trim())
		.filter(Boolean);

	const processedTokens: string[] = [];
	for (const rawToken of rawTokens) {
		if (HEADER_REGEX.test(rawToken)) {
			continue;
		}

		const extractedCrds = extractNumericCrdsFromText(rawToken);
		if (extractedCrds.length) {
			processedTokens.push(...extractedCrds);
			continue;
		}

		const prefixMatch = rawToken.match(PREFIX_NUMERIC_REGEX);
		if (prefixMatch) {
			processedTokens.push(prefixMatch[1]);
			continue;
		}

		if (/^[\d\s]+$/.test(rawToken) && /\s/.test(rawToken)) {
			const parts = rawToken
				.split(/\s+/)
				.map((v) => v.trim())
				.filter(Boolean);
			processedTokens.push(...parts);
		} else {
			processedTokens.push(rawToken);
		}
	}

	return Array.from(new Set(processedTokens));
}

export function buildQueueRunItems(queries: string[]) {
	return queries
		.map((query) => query.trim())
		.filter(Boolean)
		.map((query) => ({ query, status: 'queued' as const, elapsedSec: 0 }));
}

export function createQueueTerminalLogId(kind: string, index: number, step: number) {
	return `queue:${kind}:${index}:${step}`;
}

export function computeQueryFetchCounts(resolution: Array<{ query?: string; crds?: string[] }>, fetchedItems: Array<{ crd?: string; status?: string }>) {
	const counts = new Map<string, number>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));

		const addedCount = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()) && String(item?.status || '') === 'ok').length;
		counts.set(query, addedCount);
	}

	return Object.fromEntries(counts.entries());
}

export function computeQuerySaveStats(
	resolution: Array<{ query?: string; crds?: string[] }>,
	fetchedItems: Array<{
		crd?: string;
		type?: string;
		status?: string;
		cardKey?: string;
		newSourceSaved?: boolean;
		newRecordSaved?: boolean;
	}>,
) {
	const stats = new Map<
		string,
		{
			fetchedCount: number;
			skippedCount: number;
			savedSourceCount: number;
			savedRecordCount: number;
			updatedExistingSourceCount: number;
			updatedExistingRecordCount: number;
			errorCount: number;
		}
	>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));
		const matchingItems = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()));
		const savedRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newRecordSaved === true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);
		const updatedExistingRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);

		stats.set(query, {
			fetchedCount: matchingItems.filter((item) => String(item?.status || '') === 'ok').length,
			skippedCount: matchingItems.filter((item) => String(item?.status || '') === 'skipped').length,
			savedSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true).length,
			savedRecordCount: savedRecordKeys.size,
			updatedExistingSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true).length,
			updatedExistingRecordCount: updatedExistingRecordKeys.size,
			errorCount: matchingItems.filter((item) => String(item?.status || '') === 'error').length,
		});
	}

	return Object.fromEntries(stats.entries());
}

export function describeQuerySaveChange(stats?: { savedRecordCount?: number; updatedExistingRecordCount?: number; updatedExistingSourceCount?: number }) {
	const newRecordCount = Number(stats?.savedRecordCount || 0);
	const updatedExistingRecordCount = Number(stats?.updatedExistingRecordCount || 0);
	const updatedExistingSourceCount = Number(stats?.updatedExistingSourceCount || 0);

	if (newRecordCount > 0 && updatedExistingRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'} • ${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	if (newRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'}`;
	}

	if (updatedExistingRecordCount > 0) {
		return `${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	return 'no new data saved';
}

export function shouldShowQueueCardError(card: {
	sources?: Array<{
		source?: string;
		status?: string;
		error?: string;
		skipReason?: string;
	}>;
}) {
	return Array.isArray(card.sources) && card.sources.some((entry) => String(entry?.status || '') === 'error');
}

export function shouldShowQueueCardSkipped(card: {
	sources?: Array<{
		source?: string;
		status?: string;
		error?: string;
		skipReason?: string;
	}>;
}) {
	return Array.isArray(card.sources) && !shouldShowQueueCardError(card) && card.sources.some((entry) => String(entry?.status || '') === 'skipped');
}

export function describeDashboardRequestFailure(options: { status?: number; contentType?: string | null; bodyText?: string; errorMessage?: string; elapsedSec?: number }) {
	const status = Number(options.status || 0);
	const contentType = String(options.contentType || '').toLowerCase();
	const bodyText = String(options.bodyText || '');
	const errorMessage = String(options.errorMessage || '');
	const elapsedSec = Math.max(0, Number(options.elapsedSec || 0));
	const combined = `${bodyText}\n${errorMessage}`.toLowerCase();
	if (combined.includes('aborted without reason') || combined.includes('request aborted') || combined.includes('aborterror')) {
		return 'Queue request was cancelled by the browser timeout. The crawl may still be running; please wait a bit longer and try again.';
	}
	const timeoutLike =
		status === 408 ||
		status === 504 ||
		status === 524 ||
		combined.includes('timed out') ||
		combined.includes('timeout') ||
		combined.includes('function invocation') ||
		combined.includes('gateway') ||
		combined.includes('body exceeded');

	if (timeoutLike) {
		return `Queue likely timed out after ${elapsedSec || 30}s. Try fewer names or rerun in smaller chunks.`;
	}

	if (status >= 500 && !contentType.includes('application/json')) {
		return 'Queue failed before the dashboard received JSON. The server likely returned an HTML or gateway error page.';
	}

	if (status >= 400 && bodyText.trim()) {
		return bodyText.trim().slice(0, 240);
	}

	return errorMessage || 'Queue request failed.';
}

export function buildQueueCardsFromFetchResults(items: any[]): QueueCard[] {
	const map = new Map<string, QueueCard>();
	for (const item of items) {
		const id = String(item?.crd || '').trim();
		const source = String(item?.source || '')
			.trim()
			.toLowerCase() as SearchResultSource;
		const entity =
			(
				String(item?.type || '')
					.trim()
					.toLowerCase() === 'firm'
			) ?
				'firm'
			:	'individual';
		if (!/^\d{1,10}$/.test(id)) continue;
		if (source !== 'finra' && source !== 'sec') continue;

		const key = `${entity}:${id}`;
		const existing = map.get(key) || {
			id,
			entity,
			files: 0,
			sources: [],
		};

		existing.files += 1;
		const nextSource: QueueCardSourceEntry = {
			source,
			status:
				item?.status === 'error' ? 'error'
				: item?.status === 'skipped' ? 'skipped'
				: item?.status === 'ok' ? 'ok'
				: 'unknown',
			error: item?.error ? String(item.error) : undefined,
			skipReason: item?.skipReason ? String(item.skipReason) : undefined,
		};

		const sourceIndex = existing.sources.findIndex((entry) => entry.source === source);
		if (sourceIndex >= 0) existing.sources[sourceIndex] = nextSource;
		else existing.sources.push(nextSource);

		map.set(key, existing);
	}

	return Array.from(map.values());
}

function normalizePayloadForCleanView(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

	const obj = payload as Record<string, any>;
	if (Array.isArray(obj?.hits?.hits) && obj.hits.hits.length) {
		const source = obj.hits.hits[0]?._source ?? obj.hits.hits[0];
		if (source && typeof source === 'object') {
			return normalizeRenderablePayload(source);
		}
	}

	return normalizeRenderablePayload(obj);
}

function extractEntityDetailFromPayload(payload: any, entity: 'individual' | 'firm', crd: string) {
	if (!payload || typeof payload !== 'object') return null;

	// Handle nested Elasticsearch response structure (hits.hits[0]._source)
	let data = payload;
	if (Array.isArray(payload?.hits?.hits) && payload.hits.hits.length > 0) {
		data = payload.hits.hits[0]?._source || {};
	}

	// Normalize payload structure - handle raw API responses with content/iacontent wrappers
	let normalized = data;
	if (typeof data.content === 'string') {
		try {
			normalized = JSON.parse(data.content);
		} catch {
			// If parse fails, continue with the original data
		}
	}
	if (typeof data.iacontent === 'string') {
		try {
			normalized = { ...normalized, ...JSON.parse(data.iacontent) };
		} catch {
			// If parse fails, continue with the current normalized data
		}
	}

	// For individuals
	if (entity === 'individual') {
		const firstName = normalized.bc?.firstName || normalized.ia?.firstName || normalized.basicInformation?.firstName || '';
		const lastName = normalized.bc?.lastName || normalized.ia?.lastName || normalized.basicInformation?.lastName || '';
		const name =
			[firstName, lastName].filter(Boolean).join(' ').trim() ||
			normalized.fullName ||
			normalized.individualName ||
			normalized.orphan?.name ||
			normalized.name ||
			normalized.basicInformation?.fullName ||
			normalized.basicInformation?.individualName ||
			'';
		const bcScope = normalized.bc?.bcScope || normalized.basicInformation?.bcScope || 'N/A';
		const iaScope = normalized.ia?.iaScope || normalized.basicInformation?.iaScope || 'N/A';

		return {
			id: crd,
			entity,
			name: name || `Individual ${crd}`,
			status: [bcScope, iaScope].filter((s) => s && s !== 'N/A').join(' • ') || 'No status',
		};
	}

	// For firms
	if (entity === 'firm') {
		const legalName =
			normalized.legalName ||
			normalized.basicInformation?.legalName ||
			normalized.basicInformation?.firmName ||
			normalized.basicInformation?.iaFirmName ||
			normalized.orphan?.firmName ||
			normalized.orphan?.name ||
			normalized.firmName ||
			normalized.iaFirmName ||
			'';
		const doingBusinessAs = normalized.doingBusinessAs || normalized.basicInformation?.doingBusinessAs || normalized.dba || normalized.basicInformation?.dba || '';
		const name = legalName || doingBusinessAs || `Firm ${crd}`;

		return {
			id: crd,
			entity,
			name,
			status: 'Firm',
		};
	}

	return null;
}

function inferEntityTypeFromNewCrd(item: { type?: string; scopes?: string[] }): 'individual' | 'firm' {
	const typeText = String(item?.type || '')
		.trim()
		.toLowerCase();
	const scopesText = Array.isArray(item?.scopes) ? item.scopes.join(' ').toLowerCase() : '';
	const combined = `${typeText} ${scopesText}`;
	if (combined.includes('firm') || combined.includes('company') || combined.includes('organization') || combined.includes('org')) {
		return 'firm';
	}
	return 'individual';
}

function buildReadableSummaryRows(payload: Record<string, any>) {
	const rows: Array<{ label: string; value: string }> = [];
	const push = (label: string, raw: unknown) => {
		if (raw == null) return;
		const value = String(raw).trim();
		if (!value || value === 'N/A' || value === 'null' || value === 'undefined') return;
		rows.push({ label, value });
	};

	push('Name', payload.name || payload.fullName || payload.legalName || payload.basicInformation?.legalName);
	push('Status', payload.status || payload.registrationStatus || payload.bcScope || payload.iaScope || payload.basicInformation?.bcScope || payload.basicInformation?.iaScope);
	push('City', payload.city || payload.town || payload.mailingAddress?.city || payload.businessAddress?.city);
	push('State', payload.state || payload.mailingAddress?.state || payload.businessAddress?.state);
	push('Country', payload.country || payload.mailingAddress?.country || payload.businessAddress?.country);
	push('BD', payload.bdSecNumber || payload.basicInformation?.bdSecNumber);
	push('CRD', payload.crd || payload.firmId || payload.individualId);

	if (!rows.length) {
		for (const [key, value] of Object.entries(payload)) {
			if (value == null || typeof value === 'object') continue;
			const str = String(value).trim();
			if (!str) continue;
			rows.push({ label: key, value: str });
			if (rows.length >= 12) break;
		}
	}

	return rows;
}

function maybeParseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

function unwrapRecordPayload(input: unknown): any {
	const parsed = maybeParseJson(input);
	if (parsed == null || typeof parsed !== 'object') return parsed;
	if (Array.isArray(parsed)) return parsed;

	const payload = parsed as Record<string, unknown>;
	if (payload.finraBrokerCheck && typeof payload.finraBrokerCheck === 'object') {
		return unwrapRecordPayload(payload.finraBrokerCheck);
	}
	if (payload.secInvestmentAdvisor && typeof payload.secInvestmentAdvisor === 'object') {
		return unwrapRecordPayload(payload.secInvestmentAdvisor);
	}

	if (payload.content != null) return unwrapRecordPayload(payload.content);
	// Prefer FINRA bccontent when present; merge SEC iacontent underneath.
	if (payload.bccontent != null || payload.iacontent != null) {
		const finra = payload.bccontent != null ? unwrapRecordPayload(payload.bccontent) : null;
		const sec = payload.iacontent != null ? unwrapRecordPayload(payload.iacontent) : null;
		if (finra && typeof finra === 'object' && sec && typeof sec === 'object' && !Array.isArray(finra) && !Array.isArray(sec)) {
			return { ...(sec as Record<string, unknown>), ...(finra as Record<string, unknown>) };
		}
		return finra ?? sec;
	}

	const firstHit = Array.isArray((payload.hits as any)?.hits) ? (payload.hits as any).hits[0] : null;
	if (firstHit && typeof firstHit === 'object') {
		const source = (firstHit as any)._source;
		if (source && typeof source === 'object') {
			if ((source as any).content != null) return unwrapRecordPayload((source as any).content);
			if ((source as any).iacontent != null) return unwrapRecordPayload((source as any).iacontent);
			return unwrapRecordPayload(source);
		}
	}

	if ((payload as any)._source && typeof (payload as any)._source === 'object') {
		return unwrapRecordPayload((payload as any)._source);
	}

	return payload;
}

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function pickFirstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = toText(value);
		if (text) return text;
	}
	return '';
}

function normalizeCrd(value: unknown): string {
	const text = toText(value);
	if (!text) return '';
	if (/^\d{1,10}$/.test(text)) return text;
	const extracted = extractNumericCrdsFromText(text)[0] || '';
	if (extracted) return extracted;
	const loose = text.match(/\b(\d{1,10})\b/);
	return loose?.[1] || '';
}

function pickFirstValidCrd(...values: unknown[]): string {
	for (const value of values) {
		const crd = normalizeCrd(value);
		if (crd) return crd;
	}
	return '';
}

function parseOrphanOwnerHintsFromSearchParams(params: URLSearchParams | null | undefined): DashboardOrphanOwnerHints | null {
	if (!params) return null;
	const parentCrd = pickFirstValidCrd(params.get('parentCrd'), params.get('parentFirm'), params.get('orphanParentCrd'));
	if (!parentCrd) return null;
	const name = pickFirstNonEmpty(params.get('orphanName'), params.get('name'));
	const position = pickFirstNonEmpty(params.get('orphanPosition'), params.get('position'));
	const firmName = pickFirstNonEmpty(params.get('orphanFirmName'), params.get('firmName'));
	const firmStatus = pickFirstNonEmpty(params.get('orphanFirmStatus'), params.get('firmStatus'));
	if (!name && !firmName && !position) return null;
	return {
		parentCrd,
		name: name || undefined,
		position: position || undefined,
		firmName: firmName || undefined,
		firmStatus: firmStatus || undefined,
	};
}

function buildNonLiveOwnerDashboardHref(params: {
	crd: string;
	parentCrd: string;
	name?: string;
	position?: string;
	firmName?: string;
	firmStatus?: string;
	isNonLive?: boolean;
}) {
	const crd = pickFirstValidCrd(params.crd);
	if (!crd) return '';
	const parentCrd = pickFirstValidCrd(params.parentCrd);
	const shouldAttachHints = Boolean(params.isNonLive && parentCrd);
	if (!shouldAttachHints) return `/dashboard/individual/${crd}`;

	const query = new URLSearchParams();
	query.set('parentCrd', parentCrd);
	if (params.name) query.set('orphanName', params.name);
	if (params.position) query.set('orphanPosition', params.position);
	if (params.firmName) query.set('orphanFirmName', params.firmName);
	if (params.firmStatus) query.set('orphanFirmStatus', params.firmStatus);
	return `/dashboard/individual/${crd}?${query.toString()}`;
}

function appendOrphanHintsToIndividualApiUrl(baseUrl: string, hints?: DashboardOrphanOwnerHints | null) {
	if (!hints?.parentCrd) return baseUrl;
	try {
		const url = new URL(baseUrl, 'http://localhost');
		url.searchParams.set('parentCrd', String(hints.parentCrd));
		if (hints.name) url.searchParams.set('orphanName', hints.name);
		if (hints.position) url.searchParams.set('orphanPosition', hints.position);
		if (hints.firmName) url.searchParams.set('orphanFirmName', hints.firmName);
		if (hints.firmStatus) url.searchParams.set('orphanFirmStatus', hints.firmStatus);
		return `${url.pathname}${url.search}`;
	} catch {
		return baseUrl;
	}
}

function looksLikeGenericEntityLabel(value: unknown) {
	const text = toText(value);
	if (!text) return true;
	return /^(firm|individual)\s+\d{1,10}$/i.test(text) || /^employment\s+\d+$/i.test(text) || /^owner\s+\d+$/i.test(text) || /^result$/i.test(text);
}

function buildPersonNameFromRecord(record: Record<string, any>) {
	return buildPersonName(record?.firstName, record?.middleName, record?.lastName, record?.suffix);
}

function resolveEntityNodeLabel(record: Record<string, any> | null | undefined, entity: 'individual' | 'firm', crd?: string, indexFallback?: number) {
	const row = record || {};
	const basic = row?.basicInformation && typeof row.basicInformation === 'object' ? row.basicInformation : {};
	const personName = buildPersonNameFromRecord(row);
	const basicPersonName = buildPersonNameFromRecord(basic);
	const label = pickFirstNonEmpty(
		row?.legalName,
		row?.connectionName,
		row?.name,
		row?.fullName,
		row?.individualName,
		row?.orphan?.name,
		row?.orphan?.firmName,
		row?.firmName,
		row?.iaFirmName,
		basic?.legalName,
		basic?.connectionName,
		basic?.name,
		basic?.fullName,
		basic?.individualName,
		basic?.firmName,
		basic?.iaFirmName,
		row?.organizationName,
		row?.companyName,
		row?.doingBusinessAs,
		row?.dba,
		row?.employerName,
		row?.entityName,
		personName,
		basicPersonName,
	);

	if (label && !looksLikeGenericEntityLabel(label)) {
		return entity === 'firm' ? formatFirmName(label) : formatPersonName(label);
	}
	if (crd) return `${entity === 'firm' ? 'Firm' : 'Individual'} CRD #${crd}`;
	if (typeof indexFallback === 'number') return `${entity === 'firm' ? 'Firm' : 'Individual'} ${indexFallback + 1}`;
	return entity === 'firm' ? 'Firm' : 'Individual';
}

function formatAddress(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, unknown>;
	const preferredKeys = ['address1', 'address2', 'address3', 'street1', 'street2', 'city', 'state', 'postalCode', 'zipCode', 'zip', 'country'];
	const parts: string[] = [];
	for (const key of preferredKeys) {
		const text = toText(address[key]);
		if (text) parts.push(text);
	}
	if (parts.length > 0) return parts.join(', ');
	return Object.values(address)
		.map((v) => toText(v))
		.filter(Boolean)
		.join(', ');
}

function extractCurrentBranchOfficeAddress(body: Record<string, any>): string {
	const employments = [...toArray(body?.currentEmployments), ...toArray(body?.currentIAEmployments), ...toArray(body?.currentEmployment)];
	for (const employment of employments) {
		const branches = toArray(employment?.branchOfficeLocations);
		const located = branches.find((b) => toText(b?.locatedAtFlag).toUpperCase() === 'Y') || branches[0];
		if (located) {
			const address = formatAddress(located);
			if (address) return address;
		}
	}
	return '';
}

function collectOtherNames(...lists: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const item of toArray(list)) {
			const value = toText(item);
			if (!value) continue;
			const normalized = value.toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(value);
		}
	}
	return out;
}

function humanizeKey(key: string): string {
	if (/\s/.test(key)) return key;
	return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function isEmptyRawValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
	return false;
}

function stringifyRawValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (!value.length) return '';
		if (value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
			return value.map((v) => String(v)).join(', ');
		}
		return JSON.stringify(value, null, 2);
	}
	if (value && typeof value === 'object') {
		return JSON.stringify(value, null, 2);
	}
	return '';
}

const DETAIL_SKIP_KEYS = new Set([
	'basicInformation',
	'firmAddressDetails',
	'iaFirmAddressDetails',
	'disclosures',
	'directOwners',
	'registrationStatus',
	'registeredSROs',
	'registeredStates',
	'registrations',
	'currentConnections',
	'previousConnections',
	'currentEmployments',
	'currentIAEmployments',
	'currentEmployment',
	'previousEmployments',
	'previousIAEmployments',
	'otherNames',
	'aliases',
	'stateExamCategory',
	'productExamCategory',
	'principalExamCategory',
	'stateExams',
	'productExams',
	'principalExams',
	'exams',
	'crs',
	'Crs',
	'CRS',
	'affiliateDisclosures',
	'Affiliate Disclosures',
	'brochures',
	'noticeFilings',
	'secDocumentLinks',
	'bdDisclosureFlag',
	'iaDisclosureFlag',
]);

const HIDDEN_DETAIL_LABELS = new Set(['Exams Count', 'Registration Count', 'Broker Details', 'Has Finra Data', 'Has Sec Data']);

function shouldHideDetailLabel(label: string) {
	return HIDDEN_DETAIL_LABELS.has(label);
}

const LOCAL_HISTORY_KEY = 'finra_dashboard_history';
const NEW_CRD_CLIENT_CACHE_KEY = 'finra_dashboard_new_crds_cache';
const NEW_CRD_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
// Matches the server-side dashboard card-list cache TTL (DASHBOARD_CARD_LIST_CACHE_TTL_MS in
// src/app/api/dashboard/refresh/route.ts). Polling faster than this only re-fetches the same
// cached payload, so keep client polling aligned with it to avoid redundant requests.
const QUEUE_CARD_LIST_POLL_MS = 30_000;
// Keep the local history indefinitely. Using a very large numeric sentinel so
// existing slice(0, LOCAL_HISTORY_MAX) calls keep all entries.
const LOCAL_HISTORY_MAX = Number.POSITIVE_INFINITY;

type LocalHistoryEntry = {
	id: string;
	entity: 'individual' | 'firm';
	sources: QueueCardSourceEntry[];
	fetchedAt: string;
	name?: string;
	visitCount?: number;
	lastVisitedAt?: string;
};

type NewCrdEntry = {
	id: string;
	type: string;
	found: string;
	scopes: string[];
	date: string;
	name?: string | null;
	fullName?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	firmName?: string | null;
	legalName?: string | null;
};

type SavedTemplate = {
	id: string;
	name: string;
	queries: string;
};

function extractDisplayNameFromNewCrd(entry: NewCrdEntry, entity: 'individual' | 'firm') {
	const combinedPersonName = [toText(entry.firstName), toText(entry.lastName)].filter(Boolean).join(' ').trim();
	const rawName = pickFirstNonEmpty(entry.name, entry.fullName, entry.firmName, entry.legalName, combinedPersonName);
	if (rawName) return rawName;
	return entity === 'firm' ? `Firm ${entry.id}` : `Individual ${entry.id}`;
}

function readCachedNewCrds(): NewCrdEntry[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = window.localStorage.getItem(NEW_CRD_CLIENT_CACHE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as { fetchedAt?: number; newCrds?: NewCrdEntry[] } | NewCrdEntry[];
		const entryList =
			Array.isArray(parsed) ? parsed
			: Array.isArray(parsed?.newCrds) ? parsed.newCrds
			: [];
		const fetchedAt = Array.isArray(parsed) ? 0 : Number(parsed?.fetchedAt || 0);
		if (fetchedAt && Date.now() - fetchedAt > NEW_CRD_CLIENT_CACHE_TTL_MS) return [];
		return Array.isArray(entryList) ? entryList : [];
	} catch {
		return [];
	}
}

function writeCachedNewCrds(entries: NewCrdEntry[]) {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(
			NEW_CRD_CLIENT_CACHE_KEY,
			JSON.stringify({
				fetchedAt: Date.now(),
				newCrds: entries,
			}),
		);
	} catch {
		// ignore storage failures
	}
}

function getQueueCardSources(card: QueueCard): {
	hasFinra: boolean;
	hasSec: boolean;
} {
	const sources = (card.sources || []).map((s) => String(s.source).toLowerCase());
	const hasFinra = sources.includes('finra');
	const hasSec = sources.includes('sec');
	if (!hasFinra && !hasSec) {
		return { hasFinra: true, hasSec: false };
	}
	return { hasFinra, hasSec };
}

function getNewCrdSources(entry: NewCrdEntry, entity: 'individual' | 'firm', localHistory?: LocalHistoryEntry[]): { hasFinra: boolean; hasSec: boolean } {
	const scopes = (entry.scopes || []).map((s) => String(s).toLowerCase());
	const typeStr = String(entry.type || '').toLowerCase();
	let hasFinra = scopes.includes('finra') || scopes.includes('bc') || typeStr.includes('finra');
	let hasSec = scopes.includes('sec') || scopes.includes('ia') || typeStr.includes('sec');

	if (localHistory) {
		const hist = localHistory.find((h) => h.id === entry.id && h.entity === entity);
		if (hist && Array.isArray(hist.sources)) {
			const histSources = hist.sources.map((s) => String(s.source).toLowerCase());
			if (histSources.includes('finra')) hasFinra = true;
			if (histSources.includes('sec')) hasSec = true;
		}
	}

	if (!hasFinra && !hasSec) {
		hasFinra = true;
	}
	return { hasFinra, hasSec };
}

function formatMainPanelTitle(options: { source: SearchResultSource; entity: 'individual' | 'firm'; id: string; name?: string | null; payload?: unknown }) {
	const sourceLabel = String(options.source).toUpperCase();
	const titleName = toText(options.name) || getRecordDisplayName(options.payload, options.entity, options.id);
	if (titleName) return titleName;
	return `${options.entity === 'firm' ? 'Firm' : 'Individual'} ${options.id}`;
}

function formatAddressCandidate(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, any>;
	const parts = [address.address1, address.address2, address.street1, address.street2, address.city, address.state, address.zipCode || address.postalCode, address.country]
		.map((entry) => toText(entry))
		.filter(Boolean);
	return parts.join(', ');
}

function findNestedValueByKey(input: unknown, candidates: string[]): unknown {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		const normalized = String(key).trim().toLowerCase();
		if (candidates.some((candidate) => normalized === candidate.toLowerCase() || normalized.includes(candidate.toLowerCase()))) {
			return coerceStructuredValue(value);
		}
		const nestedValue = coerceStructuredValue(value);
		if (nestedValue && typeof nestedValue === 'object') {
			const nested = findNestedValueByKey(nestedValue, candidates);
			if (nested != null) return nested;
		}
	}
	return null;
}

function extractJurisdictionCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source =
		Array.isArray(normalizedBody) ? normalizedBody : (
			findNestedValueByKey(normalizedBody ?? body, ['jurisdictions', 'stateNoticeDetails', 'stateNoticeRecords', 'stateNoticeHistory', 'jurisdiction'])
		);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.jurisdiction, record?.jurisdictionName, record?.name, record?.state);
			const meta = pickFirstNonEmpty(record?.status, record?.noticeStatus, record?.noticeStatusText);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effective_date, record?.dateFiled, record?.dateSubmitted, record?.noticeDate);
			return title ? { title, meta, subtitle } : null;
		})
		.filter(Boolean) as Array<{
		title: string;
		meta: string;
		subtitle: string;
	}>;
}

function extractBrochureCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const brochureContainer = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['brochures', 'brochuredetails', 'brochureDetails']);
	const entries =
		Array.isArray(brochureContainer) ? brochureContainer
		: brochureContainer && typeof brochureContainer === 'object' && Array.isArray((brochureContainer as Record<string, any>).brochuredetails) ?
			(brochureContainer as Record<string, any>).brochuredetails
		:	[];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.brochureName, record?.name, record?.brochureTitle);
			const meta = pickFirstNonEmpty(record?.brochureVersionID, record?.versionId, record?.version);
			const submitted = pickFirstNonEmpty(record?.dateSubmitted, record?.submittedDate, record?.date);
			const confirmed = pickFirstNonEmpty(record?.lastConfirmed, record?.confirmedDate);
			const subtitleParts = [submitted ? `Submitted: ${submitted}` : '', confirmed ? `Last Confirmed: ${confirmed}` : ''].filter(Boolean);
			const subtitle = subtitleParts.join(' • ');
			return title ? { title, meta: meta ? `ID #${meta}` : '', subtitle } : null;
		})
		.filter(Boolean) as Array<{
		title: string;
		meta: string;
		subtitle: string;
	}>;
}

export function extractRegistrationCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['registrations', 'registrationDetails', 'registrationHistory']);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.registrationName, record?.name, record?.title, record?.registrationTitle, record?.seriesName);
			const meta = pickFirstNonEmpty(record?.status, record?.registrationStatus, record?.state, record?.jurisdiction);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effectiveDateText, record?.date, record?.registrationDate);
			return title ? { title, meta, subtitle } : null;
		})
		.filter(Boolean) as Array<{
		title: string;
		meta: string;
		subtitle: string;
	}>;
}

export function extractConnectionCards(body: Record<string, any>, key: 'currentConnections' | 'previousConnections') {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const candidateKeys =
		key === 'currentConnections' ?
			[
				'currentConnections',
				'current_connections',
				'currentConnection',
				'activeConnections',
				'currentAssociatedIndividuals',
				'currentIndividuals',
				'currentConnectedIndividuals',
				'currentRegistrations',
			]
		:	[
				'previousConnections',
				'previous_connections',
				'previousConnection',
				'formerConnections',
				'previousAssociatedIndividuals',
				'previousIndividuals',
				'formerConnectedIndividuals',
				'previousRegistrations',
			];

	let source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, candidateKeys);

	if (!source) {
		const rawConns = findNestedValueByKey(normalizedBody ?? body, ['connections', 'firmConnections', 'affiliatedFirms', 'associatedIndividuals']);
		if (Array.isArray(rawConns)) {
			const isInactive = (c: any) => /previous|former|terminated|inactive/i.test(String(c.relationship || c.status || c.firmStatus || c.employmentStatus || c.position || ''));
			if (key === 'currentConnections') {
				source = rawConns.filter((c: any) => c && typeof c === 'object' && c.isCurrent !== false && !c.endDate && !isInactive(c));
			} else {
				source = rawConns.filter((c: any) => c && typeof c === 'object' && (c.isCurrent === false || !!c.endDate || isInactive(c)));
			}
		}
	}

	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const crd = pickFirstValidCrd(record?.crdNumber, record?.crd, record?.individualId, record?.personId, record?.firmId, record?.organizationCrd, record?.sourceId);
			const entityType: 'individual' | 'firm' = record?.individualId || record?.personId || record?.firstName || record?.lastName || record?.individualName ? 'individual' : 'firm';
			const title = resolveEntityNodeLabel(record, entityType, crd);
			const meta = pickFirstNonEmpty(record?.relationship, record?.position, record?.title, record?.status, record?.ownershipCode);
			const startDate = pickFirstNonEmpty(record?.effectiveDate, record?.date, record?.startDate, record?.fromDate, record?.registrationBeginDate);
			const endDate = pickFirstNonEmpty(record?.endDate, record?.toDate, record?.registrationEndDate);
			const dateText = startDate && endDate ? `${startDate} - ${endDate}` : pickFirstNonEmpty(startDate, endDate);
			const addressText = pickFirstNonEmpty(
				record?.address,
				formatAddress(record?.officeAddress),
				formatAddress(record?.branchOfficeLocations?.[0]),
				formatAddress(record?.mailingAddress),
				[toText(record?.city), toText(record?.state)].filter(Boolean).join(', '),
			);
			const subtitle = [dateText, addressText].filter(Boolean).join(' • ');
			const otherNamesArr = Array.isArray(record?.otherNames) ? record.otherNames.map((n: unknown) => String(n || '').trim()).filter(Boolean) : [];
			const bcScope = pickFirstNonEmpty(record?.bcScope, record?.firmBCScope);
			const iaScope = pickFirstNonEmpty(record?.iaScope, record?.firmIAScope);
			const evidence = Array.isArray(record?.evidence) ? record.evidence.map((tag: unknown) => String(tag || '')) : [];
			const sourceTags = Array.from(
				new Set(
					[
						...(Array.isArray(record?.sourceTags) ? record.sourceTags : []),
						...(bcScope || record?.hasFinraData === true || evidence.some((tag) => /finra/i.test(tag)) ? ['FINRA'] : []),
						...(iaScope || record?.hasSecData === true || evidence.some((tag) => /sec/i.test(tag)) ? ['SEC'] : []),
					]
						.map((tag) => String(tag || '').toUpperCase())
						.filter((tag) => tag === 'FINRA' || tag === 'SEC'),
				),
			);
			const statusTag = resolveEmploymentStatusTag({
				...record,
				statusTag: /^(active|inactive)$/i.test(String(record?.statusTag || '')) ? record.statusTag : undefined,
				bcScope,
				iaScope,
			});
			const currentFirmId = pickFirstValidCrd(record?.currentFirmId, record?.currentEmployerCrd, record?.currentEmployerId);
			const currentFirmName = pickFirstNonEmpty(record?.currentFirmName, record?.currentEmployerName, record?.currentEmployer);
			const result: {
				title: string;
				meta: string;
				subtitle: string;
				crd?: string;
				entity?: 'individual' | 'firm';
				otherNames?: string[];
				statusTag?: string;
				sourceTags?: string[];
				bcScope?: string;
				iaScope?: string;
				startDate?: string;
				endDate?: string;
				address?: string;
				currentFirmId?: string;
				currentFirmName?: string;
				haystack?: string;
			} = {
				title: title || '',
				meta: meta || '',
				subtitle: subtitle || '',
			};
			if (otherNamesArr.length) result.otherNames = otherNamesArr;
			if (statusTag) result.statusTag = statusTag;
			if (sourceTags.length) result.sourceTags = sourceTags;
			if (bcScope) result.bcScope = bcScope;
			if (iaScope) result.iaScope = iaScope;
			if (startDate) result.startDate = startDate;
			if (endDate) result.endDate = endDate;
			if (addressText) result.address = addressText;
			if (currentFirmId) result.currentFirmId = currentFirmId;
			if (currentFirmName) result.currentFirmName = currentFirmName;
			if (crd) {
				result.crd = crd;
				result.entity = entityType;
			}
			// Omit address/city from the filter haystack — short tags like "ia" / "bd"
			// were matching place names (e.g. "Williamsburg", "Alexandria").
			result.haystack = [title, dateText, meta, crd, statusTag, currentFirmName, currentFirmId, ...(sourceTags || []), ...otherNamesArr]
				.filter(Boolean)
				.join(' ')
				.toLowerCase();
			return title ? result : null;
		})
		.filter(Boolean) as Array<{
		title: string;
		meta: string;
		subtitle: string;
		crd?: string;
		entity?: 'individual' | 'firm';
		otherNames?: string[];
		statusTag?: string;
		sourceTags?: string[];
		bcScope?: string;
		iaScope?: string;
		startDate?: string;
		endDate?: string;
		address?: string;
		currentFirmId?: string;
		currentFirmName?: string;
		haystack?: string;
	}>;
}

function extractDocumentLinkCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['secDocumentLinks', 'documentLinks', 'secLinks', 'links']);
	const entries = Array.isArray(source) ? source : [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.label, record?.title, record?.name);
			const href = pickFirstNonEmpty(record?.href, record?.url, record?.link);
			return title && href ? { title, href } : null;
		})
		.filter(Boolean) as Array<{ title: string; href: string }>;
}

export function extractNoticeFilingsCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source =
		Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['noticeFilings', 'noticeFiling', 'noticeFilingsDetails', 'noticeFilingDetails']);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.jurisdiction, record?.state, record?.name);
			const meta = pickFirstNonEmpty(record?.status, record?.noticeStatus, record?.registrationStatus);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effectiveDateText, record?.effective, record?.date, record?.noticeDate);
			const detail = pickFirstNonEmpty(record?.description, record?.details, record?.summary);
			return title ? { title, meta, subtitle, detail } : null;
		})
		.filter(Boolean) as Array<{
		title: string;
		meta: string;
		subtitle: string;
		detail: string;
	}>;
}

function extractSearchResultAddress(item: SearchResult): string {
	const directAddress = pickFirstNonEmpty(
		formatAddressCandidate(item?.businessAddress),
		formatAddressCandidate(item?.officeAddress),
		formatAddressCandidate(item?.mailingAddress),
		formatAddressCandidate(item?.address),
		[toText(item?.city), toText(item?.state)].filter(Boolean).join(', '),
	);
	if (directAddress) return directAddress;

	const employments = [
		...(Array.isArray(item?.ind_current_employments) ? item.ind_current_employments : []),
		...(Array.isArray(item?.ind_ia_current_employments) ? item.ind_ia_current_employments : []),
		...(Array.isArray(item?.currentEmployments) ? item.currentEmployments : []),
		...(Array.isArray(item?.currentIAEmployments) ? item.currentIAEmployments : []),
		// Fall back to previous employments so inactive individuals (no current employer) still show
		// a last-known address instead of nothing.
		...(Array.isArray(item?.previousEmployments) ? item.previousEmployments : []),
		...(Array.isArray(item?.previousIAEmployments) ? item.previousIAEmployments : []),
	];

	for (const row of employments) {
		const address = pickFirstNonEmpty(
			formatAddressCandidate(row?.branchOfficeLocations?.[0]),
			formatAddressCandidate(row),
			[toText(row?.city), toText(row?.state)].filter(Boolean).join(', '),
		);
		if (address) return address;
	}

	return '';
}

function extractSearchResultDetail(item: SearchResult): string {
	return pickFirstNonEmpty(item?.bcScope, item?.iaScope, item?.status, item?.registrationStatus, item?.firm_bc_scope, item?.firm_ia_scope);
}

function extractSearchResultOtherNames(item: SearchResult): string[] {
	const raw = item?.otherNames || item?.basicInformation?.otherNames || item?.ind_other_names || item?.firm_other_names || item?.aliases;
	if (!Array.isArray(raw)) return [];
	return raw.map((name) => toText(name)).filter(Boolean);
}

// Minimal FINRA/SEC search-index stub docs ({id, crd, label, type, source}) lack a real name,
// address, or otherNames — the same way graph-search's direct-CRD fallback hydrates from the
// full detail routes, fetch the merged record here so dashboard search cards show real data.
async function hydrateSearchResultCardsBatch(cards: SearchResultCard[]): Promise<SearchResultCard[]> {
	if (!cards.length) return cards;
	try {
		const res = await fetch('/api/finra/hydrate-search-cards', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cards }),
		});
		if (!res.ok) return cards;
		const payload = await res.json();
		return Array.isArray(payload?.cards) ? payload.cards.map((c: any, i: number) => {
			if (!c.hydratedFromSidecar) return cards[i];
			const label =
				c.rawLabel ?
					c.entity === 'firm' ?
						formatFirmName(c.rawLabel)
					:	formatPersonName(c.rawLabel)
				:	c.label;
			return {
				...c,
				label,
				address: c.rawAddress || c.address,
				otherNames: c.otherNames || [],
			};
		}) : cards;
	} catch {
		return cards;
	}
}

function resolveParentSummaryUrl(data: Record<string, any> | null | undefined, parentType: 'individual' | 'firm', parentCrd: string) {
	const route = parentType === 'individual' ? 'individual' : 'firm';
	const roots = [data, data?.merged, data?.finraNode, data?.secNode, data?.basicInformation].filter((v) => v && typeof v === 'object');
	for (const root of roots) {
		const secLinks = Array.isArray((root as any)?.secDocumentLinks) ? (root as any).secDocumentLinks : [];
		const secSummaryLink = secLinks.find(
			(link: any) => typeof link?.href === 'string' && /adviserinfo\.sec\.gov\//.test(link.href) && /\/summary\//.test(link.href),
		);
		if (secSummaryLink?.href) return String(secSummaryLink.href);
	}

	for (const root of roots) {
		const r = root as any;
		const secId = pickFirstNonEmpty(
			r?.iaSECNumber,
			r?.secNumber,
			r?.basicInformation?.iaSECNumber,
			r?.basicInformation?.secNumber,
			r?.ia_sec_number,
			r?.sec_number,
			r?.basicInformation?.ia_sec_number,
			r?.basicInformation?.sec_number,
		);
		if (!secId) continue;
		const normalizedId = String(secId).trim();
		// Prefer explicit 8-#### adviser numbers; bare CRDs are only used for firm parents when no better link exists.
		if (/^8-\d+$/i.test(normalizedId)) {
			return `https://adviserinfo.sec.gov/${route}/summary/${encodeURIComponent(normalizedId)}`;
		}
		if (parentType === 'firm' && /^\d{1,10}$/.test(normalizedId) && normalizedId !== String(parentCrd)) {
			return `https://adviserinfo.sec.gov/${route}/summary/${encodeURIComponent(`8-${normalizedId}`)}`;
		}
	}

	// Last resort for firm parents: adviserinfo often accepts the firm CRD path.
	if (parentType === 'firm' && pickFirstValidCrd(parentCrd)) {
		return `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(String(pickFirstValidCrd(parentCrd)))}`;
	}

	return null;
}

function OrphanProfileLinks({ parentCrd, parentType = 'firm' }: { parentCrd: string; parentType?: 'individual' | 'firm' }) {
	const [status, setStatus] = useState<{ finra: boolean; sec: boolean; secUrl: string | null } | null>(null);
	const isParentIndividual = parentType === 'individual';
	const safeParentCrd = pickFirstValidCrd(parentCrd) || '';

	useEffect(() => {
		let active = true;
		setStatus(null);
		if (!safeParentCrd) {
			setStatus({ finra: false, sec: false, secUrl: null });
			return () => {
				active = false;
			};
		}
		const endpoint = isParentIndividual
			? `/api/finra/individual/${encodeURIComponent(safeParentCrd)}?merged=1`
			: `/api/finra/firm/${encodeURIComponent(safeParentCrd)}?merged=1`;
		fetch(endpoint)
			.then((res) => res.json())
			.then((data) => {
				if (!active || !data || typeof data !== 'object') return;
				const secUrl = resolveParentSummaryUrl(data, isParentIndividual ? 'individual' : 'firm', safeParentCrd);
				const hasFinra =
					data.hasFinraData === true ||
					data.hasFinraData === false
						? Boolean(data.hasFinraData)
						: true; // non-live people always get a parent FINRA summary link when parent CRD is known
				const hasSec =
					Boolean(secUrl) &&
					(data.hasSecData === true || data.hasSecData === false ? Boolean(data.hasSecData) || Boolean(secUrl) : Boolean(secUrl));
				setStatus({
					// Firm parents with a CRD always expose BrokerCheck firm summary for non-live people.
					finra: isParentIndividual ? hasFinra : true,
					sec: Boolean(hasSec && secUrl),
					secUrl,
				});
			})
			.catch(() => {
				if (active) {
					setStatus({
						finra: true,
						sec: !isParentIndividual,
						secUrl: !isParentIndividual ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(safeParentCrd)}` : null,
					});
				}
			});
		return () => {
			active = false;
		};
	}, [safeParentCrd, isParentIndividual]);

	if (!safeParentCrd) return <div style={{ fontSize: '13px', color: '#64748b' }}>No parent firm CRD available for external links.</div>;

	if (!status) return <div style={{ fontSize: '13px', color: '#64748b' }}>Validating parent {isParentIndividual ? 'individual' : 'firm'} sources...</div>;

	if (!status.finra && !status.sec) return <div style={{ fontSize: '13px', color: '#64748b' }}>No external parent links available.</div>;

	// Non-live people have no individual BrokerCheck/IAPD page — surface the parent
	// firm's FINRA/SEC summary links with the same button labels as a live person profile.
	return (
		<div className={styles.detailLinkRow}>
			{status.finra && (
				<a
					href={`https://brokercheck.finra.org/${isParentIndividual ? 'individual' : 'firm'}/summary/${safeParentCrd}`}
					target='_blank'
					rel='noopener noreferrer'
					className={`${styles.detailLinkBtn} ${styles.detailLinkBtnFinra}`}>
					FINRA profile ↗
				</a>
			)}
			{status.sec && status.secUrl && (
				<a
					href={status.secUrl}
					target='_blank'
					rel='noopener noreferrer'
					className={`${styles.detailLinkBtn} ${styles.detailLinkBtnSec}`}>
					SEC profile ↗
				</a>
			)}
		</div>
	);
}

/**
 * Tag-based "Filter connections…" input shared by the dashboard's Current/Previous
 * Connections filter and (conceptually) mirrored by the graph sidebar's equivalent
 * filter — both read/write the same localStorage-backed state in `src/lib/filterTags.ts`
 * so committed tags stay in sync across the dashboard and graph pages/tabs.
 * Typing text and pressing Enter (or comma) converts it into a removable tag chip;
 * matching uses AND logic across all committed tags plus the live (uncommitted) text.
 */
function FilterTagsInput({
	tags,
	liveText,
	onTagsChange,
	onLiveTextChange,
	placeholder,
	disabled,
	onFocusChange,
	onCommitTag,
}: {
	tags: string[];
	liveText: string;
	onTagsChange: (tags: string[]) => void;
	onLiveTextChange: (text: string) => void;
	placeholder?: string;
	disabled?: boolean;
	onFocusChange?: (focused: boolean) => void;
	onCommitTag?: () => void;
}) {
	const commitLiveTextAsTag = useCallback(() => {
		const trimmed = liveText.trim();
		if (!trimmed) return false;
		const newTags = trimmed
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		if (!newTags.length) return false;
		onCommitTag?.();
		onTagsChange([...tags, ...newTags]);
		onLiveTextChange('');
		return true;
	}, [liveText, tags, onTagsChange, onLiveTextChange, onCommitTag]);

	return (
		<div className={`${styles.filterTagsWrap} ${disabled ? styles.filterTagsWrapDisabled : ''}`}>
			{tags.map((tag) => (
				<span
					key={tag}
					className={styles.filterTagChip}>
					{tag}
					<button
						type='button'
						className={styles.filterTagChipRemove}
						aria-label={`Remove filter tag ${tag}`}
						onClick={() => onTagsChange(tags.filter((t) => t !== tag))}>
						×
					</button>
				</span>
			))}
			<input
				type='text'
				value={liveText}
				onChange={(event) => onLiveTextChange(event.target.value)}
				onFocus={() => onFocusChange?.(true)}
				onPaste={(event) => {
					const pasted = event.clipboardData.getData('text');
					if (pasted.includes(',')) {
						event.preventDefault();
						const newTags = pasted
							.split(',')
							.map((t) => t.trim())
							.filter(Boolean);
						if (newTags.length) {
							onCommitTag?.();
							onTagsChange([...tags, ...newTags]);
						}
					}
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter' || event.key === ',') {
						event.preventDefault();
						commitLiveTextAsTag();
					} else if (event.key === 'Backspace' && !liveText && tags.length > 0) {
						onTagsChange(tags.slice(0, -1));
					}
				}}
				onBlur={() => {
					commitLiveTextAsTag();
					onFocusChange?.(false);
				}}
				placeholder={tags.length ? 'Add another filter…' : placeholder || 'Filter connections…'}
				className={styles.filterTagsInput}
			/>
		</div>
	);
}

// Module-scoped cache of firm CRD -> firm info (other-names, firmName, scope/status),
// shared across the whole dashboard so re-rendering different records (or revisiting the same
// firm's employment rows) doesn't re-fetch data already looked up this session.
type CachedFirmInfo = {
	otherNames: string[];
	firmName?: string;
	bcScope?: string;
	iaScope?: string;
	firmStatus?: string;
	isActive?: boolean;
	hasFinraData?: boolean;
	hasSecData?: boolean;
	officeAddress?: unknown;
	address?: unknown;
};

const firmInfoCache = new Map<string, CachedFirmInfo | null>();
const firmInfoInFlight = new Map<string, Promise<CachedFirmInfo | null>>();

async function fetchFirmInfo(crd: string): Promise<CachedFirmInfo | null> {
	const safeCrd = pickFirstValidCrd(crd) || '';
	if (!safeCrd) return null;
	if (firmInfoCache.has(safeCrd)) return firmInfoCache.get(safeCrd) ?? null;
	if (firmInfoInFlight.has(safeCrd)) return firmInfoInFlight.get(safeCrd)!;
	const promise = (async () => {
		try {
			const res = await fetch(`/api/finra/firm/${encodeURIComponent(safeCrd)}?merged=1`, { headers: { Accept: 'application/json' } });
			if (!res.ok) return null;
			const data = await res.json().catch(() => null);
			const merged = data?.merged || data?.finraNode || data?.secNode || data || {};
			const basic = merged?.basicInformation && typeof merged.basicInformation === 'object' ? merged.basicInformation : merged;
			const names = extractSearchResultOtherNames(basic);
			const firmName = pickFirstNonEmpty(basic?.iaFirmName, basic?.firmName, merged?.firmName);
			const bcScope = pickFirstNonEmpty(basic?.bcScope, merged?.bcScope, basic?.brokerCheckScope, merged?.brokerCheckScope);
			const iaScope = pickFirstNonEmpty(basic?.iaScope, merged?.iaScope, basic?.secScope, merged?.secScope);
			const firmStatus = pickFirstNonEmpty(basic?.firmStatus, merged?.firmStatus, basic?.status, merged?.status);
			const bcActive =
				String(bcScope || '')
					.trim()
					.toUpperCase() === 'ACTIVE';
			const iaActive =
				String(iaScope || '')
					.trim()
					.toUpperCase() === 'ACTIVE';
			const statusActive = /^(approved|active)$/i.test(String(firmStatus || '').trim());
			const isActive = bcActive || iaActive || statusActive;
			const officeAddress = merged?.firmAddressDetails?.officeAddress || merged?.iaFirmAddressDetails?.officeAddress || basic?.officeAddress || null;
			const hasFinraData = data?.hasFinraData === true || data?.hasFinraData === false ? Boolean(data.hasFinraData) : Boolean(bcScope) || Boolean(data?.finraNode);
			const hasSecData = data?.hasSecData === true || data?.hasSecData === false ? Boolean(data.hasSecData) : Boolean(iaScope) || Boolean(data?.secNode);

			const result: CachedFirmInfo = {
				otherNames: names,
				firmName,
				bcScope,
				iaScope,
				firmStatus,
				isActive,
				hasFinraData,
				hasSecData,
				officeAddress,
				address: officeAddress,
			};
			firmInfoCache.set(safeCrd, result);
			return result;
		} catch {
			firmInfoCache.set(safeCrd, null);
			return null;
		} finally {
			firmInfoInFlight.delete(safeCrd);
		}
	})();
	firmInfoInFlight.set(safeCrd, promise);
	return promise;
}

/** Fetches (and caches) firm information for a batch of firm CRDs, exposing the results as a plain
 * `{ [crd]: CachedFirmInfo }` map that re-renders once each lookup resolves. Used by the Current/
 * Previous Employment lists so each row can show the firm's other names inline and resolve status. */
function useFirmInfoByCrd(crds: string[]): Record<string, CachedFirmInfo> {
	const [infoByCrd, setInfoByCrd] = useState<Record<string, CachedFirmInfo>>({});
	const key = crds
		.map((crd) => pickFirstValidCrd(crd) || '')
		.filter(Boolean)
		.join(',');
	useEffect(() => {
		const list = key ? key.split(',') : [];
		if (!list.length) return;
		let cancelled = false;
		(async () => {
			const pending = list.filter((crd) => !firmInfoCache.has(crd));
			for (const crd of pending) {
				await fetchFirmInfo(crd);
				if (cancelled) return;
			}
			const next: Record<string, CachedFirmInfo> = {};
			for (const crd of list) {
				const info = firmInfoCache.get(crd);
				if (info) next[crd] = info;
			}
			setInfoByCrd(next);
		})();
		return () => {
			cancelled = true;
		};
	}, [key]);
	return infoByCrd;
}

/** Renders the Redis connection label. The wording depends on `window.location.hostname`, which
 * is unavailable during SSR, so it is resolved after mount to keep the server-rendered text and
 * the first client render identical (otherwise React throws a hydration text mismatch). */
function RedisConnectionLabel() {
	const [label, setLabel] = useState('LOCAL REDIS ONLINE');
	useEffect(() => {
		if (typeof window === 'undefined' || !window.location?.hostname) return;
		const host = window.location.hostname.toLowerCase();
		if (host.includes('vercel.app') || host.includes('vercel.com')) setLabel('Redis connected');
	}, []);
	return (
		<span
			style={{
				marginRight: '8px',
				color: '#10b981',
				fontWeight: 600,
				padding: '2px 6px',
				backgroundColor: 'rgba(16, 185, 129, 0.1)',
				borderRadius: '4px',
			}}>
			{label}
		</span>
	);
}

function DashboardPageInner() {
	const pathname = usePathname();
	const searchParams = useSearchParams();

	// Heal query param: if present and allowed, trigger a background refresh for the route CRD
	useEffect(() => {
		try {
			const allow = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_ALLOW_HEAL_QUERY === '1';
			if (!allow) return;
			if (!searchParams) return;
			if (String(searchParams.get('heal') || '').trim() !== '1') return;

			const parsed = parseDashboardSelectionFromUrl(window.location.href);
			if (!parsed || !parsed.id) return;

			// fire-and-forget background heal request
			fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'fetch-crds',
					crds: [String(parsed.id)],
					includePayload: true,
				}),
			})
				.then((res) => res.json())
				.then((data) => {
					console.log('Heal requested for', parsed.id, data);
				})
				.catch((err) => {
					console.warn('Heal request failed', err);
				});
		} catch (e) {
			// ignore
		}
		// run once on mount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const [crdInput, setCrdInput] = useState('');
	const [externalRawDir, setExternalRawDir] = useState('/home/lenny/Dev/webDev/Data-finra-sec/data/raw');
	const [busyAction, setBusyAction] = useState<DashboardAction | null>(null);
	const [result, setResult] = useState<ApiResponse | null>(null);
	const [mainJson, setMainJson] = useState<Record<string, any> | null>(null);
	const [mainJsonLabel, setMainJsonLabel] = useState('');
	const [recordViewLoading, setRecordViewLoading] = useState(false);
	const [currentRecordSource, setCurrentRecordSource] = useState<'finra' | 'sec' | null>(null);
	const [currentRecordEntity, setCurrentRecordEntity] = useState<'individual' | 'firm' | null>(null);
	const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
	const [detailCollectionsOpen, setDetailCollectionsOpen] = useState(false);
	const [detailDisclosuresOpen, setDetailDisclosuresOpen] = useState(false);
	const [detailBrochuresOpen, setDetailBrochuresOpen] = useState(false);
	const [detailNoticeFilingsOpen, setDetailNoticeFilingsOpen] = useState(false);
	// Scroll container ref used together with the module-level scroll-position map above so
	// revisiting a firm/individual detail page (via a connection-card click, the browser
	// back/forward buttons, or re-opening the same card) restores the exact scroll position
	// last seen on that record, instead of always resetting to the top.
	const dashboardContentRef = useRef<HTMLDivElement | null>(null);
	const [newCrds, setNewCrds] = useState<NewCrdEntry[]>([]);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<SearchResultCard[]>([]);
	const [searchSkippedCount, setSearchSkippedCount] = useState(0);
	const [hasSearchRun, setHasSearchRun] = useState(false);
	const [searchType, setSearchType] = useState<'all' | 'people' | 'firms'>('people');
	const [crawlProgress, setCrawlProgress] = useState<{
		active: boolean;
		current: number;
		total: number;
		query: string;
		ok: number;
		new: number;
		updated: number;
		err: number;
	} | null>(null);
	const [queueElapsedSec, setQueueElapsedSec] = useState(0);
	const [terminalLogs, setTerminalLogs] = useState<{ id: string; text: string; type: 'info' | 'error' | 'warn' | 'success' }[]>([]);
	const [queueCards, setQueueCards] = useState<QueueCard[]>([]);
	const [queueCrdFilter, setQueueCrdFilter] = useState('');
	const [submittedQueueQueries, setSubmittedQueueQueries] = useState<string[]>([]);
	const [queueRunItems, setQueueRunItems] = useState<QueueRunItem[]>([]);
	const [queueMetaStats, setQueueMetaStats] = useState<{
		shownCount: number;
		totalCount: number;
		totalCacheKeys: number;
		filteredTotalCount?: number;
		sourceMode?: string;
		persistenceNotice?: string | null;
		inventoryTotals?: {
			people: number;
			firms: number;
			unique: number;
			source?: string;
		};
	}>({
		shownCount: 0,
		totalCount: 0,
		totalCacheKeys: 0,
	});
	const [syncBannerText, setSyncBannerText] = useState<string | null>(null);
	const [activeCardSourceKey, setActiveCardSourceKey] = useState<string | null>(null);
	const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false);
	const [jsonRenderBusy, setJsonRenderBusy] = useState(false);
	const [codeBlock, setCodeBlock] = useState('');
	const [jsonTree, setJsonTree] = useState<any>(null);
	const [recordUpdatedAt, setRecordUpdatedAt] = useState<string | null>(null);
	const [mainViewMode, setMainViewMode] = useState<'card' | 'json'>('card');
	const [top10Latest, setTop10Latest] = useState<
		Array<{
			id: string;
			entity: 'individual' | 'firm';
			fetchedAt: string;
			files?: number;
			sources?: QueueCardSourceEntry[];
		}>
	>([]);
	const [sessionHasFetched, setSessionHasFetched] = useState(false);
	const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>([]);
	const [isSelectionHistoryOpen, setIsSelectionHistoryOpen] = useState(true);
	const [isSelectionHistoryEditMode, setIsSelectionHistoryEditMode] = useState(false);
	const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
	const [newCrdsOpen, setNewCrdsOpen] = useState(true);
	const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
	const [isSavingTemplate, setIsSavingTemplate] = useState(false);
	const [newTemplateName, setNewTemplateName] = useState('');
	const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
	const [editTemplateName, setEditTemplateName] = useState('');
	const [editTemplateQueries, setEditTemplateQueries] = useState('');

	const recordLoadGenRef = useRef(0);
	const mergedDetailCacheRef = useRef(dashboardMergedDetailCache);
	const jsonStringCacheRef = useRef(new Map<string, string>());
	const activeLoadSourceKeyRef = useRef<string | null>(null);
	const jsonRenderInFlightKeyRef = useRef<string | null>(null);
	const refreshInFlightByCrdRef = useRef(new Map<string, Promise<any>>());
	const [connectionsLoadingFirmId, setConnectionsLoadingFirmId] = useState<string | null>(null);
	const connectionsInFlightByCrdRef = useRef(new Map<string, Promise<any>>());
	// "Filter connections…" tags + live text for the Current/Previous Connections lists below.
	// Persisted to localStorage (see src/lib/filterTags.ts) so they survive navigation and stay
	// in sync with the graph sidebar's equivalent filter (and other tabs).
	const [connectionsFilterTags, setConnectionsFilterTagsState] = useState<string[]>([]);
	const [connectionsFilterQuery, setConnectionsFilterQueryState] = useState('');
	const [connectionsFilterEnabled, setConnectionsFilterEnabledState] = useState(true);
	const [connectionsSelectMode, setConnectionsSelectMode] = useState(false);
	const [selectedConnectionKeys, setSelectedConnectionKeys] = useState<Set<string>>(new Set());
	const [connectionsFilterFocused, setConnectionsFilterFocused] = useState(false);
	const [connectionsFilterJustCommitted, setConnectionsFilterJustCommitted] = useState(false);

	useEffect(() => {
		setConnectionsFilterTagsState(getFilterTags());
		setConnectionsFilterQueryState(getFilterText());
		setConnectionsFilterEnabledState(getFilterEnabled());
		const unsubTags = subscribeFilterTags(setConnectionsFilterTagsState);
		const unsubText = subscribeFilterText(setConnectionsFilterQueryState);
		const unsubEnabled = subscribeFilterEnabled(setConnectionsFilterEnabledState);
		return () => {
			unsubTags();
			unsubText();
			unsubEnabled();
		};
	}, []);
	const setConnectionsFilterTags = useCallback((tags: string[]) => {
		setConnectionsFilterTagsState(setFilterTags(tags));
	}, []);
	const setConnectionsFilterQuery = useCallback((text: string) => {
		setConnectionsFilterQueryState(text);
		setFilterText(text);
	}, []);
	const setConnectionsFilterEnabled = useCallback((enabled: boolean) => {
		setConnectionsFilterEnabledState(setFilterEnabled(enabled));
	}, []);
	useEffect(() => {
		setConnectionsSelectMode(false);
		setSelectedConnectionKeys(new Set());
		setConnectionsFilterFocused(false);
		setConnectionsFilterJustCommitted(false);
		setDetailCollectionsOpen(false);
		setDetailDisclosuresOpen(false);
		setDetailBrochuresOpen(false);
		setDetailNoticeFilingsOpen(false);
	}, [currentRecordId, currentRecordEntity]);
	// The URL-driven auto-load effect below must only react to *external* navigation (initial
	// deep link / hard refresh, or a real browser back-forward). If it also reacted every time
	// `usePathname()` recomputes after our own syncSelectionToUrl() call (used to keep the URL
	// bar in sync with in-app clicks), it creates an infinite feedback loop: loading record A
	// writes the URL, which re-triggers the effect for a stale selection pointing back at record
	// B, which writes the URL again, alternating forever and freezing the tab. These refs let the
	// effect distinguish "real" navigation from its own echo.
	const initialRouteLoadDoneRef = useRef(false);
	const lastHandledPopNonceRef = useRef(0);
	const [popNonce, setPopNonce] = useState(0);

	useEffect(() => {
		const handlePopState = () => setPopNonce((n) => n + 1);
		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, []);

	const queueQueries = useMemo(() => parseQueueQueries(crdInput), [crdInput]);
	const parsedCrds = useMemo(() => queueQueries.filter((value) => /^\d{1,10}$/.test(value)), [queueQueries]);
	const queueQueryLines = useMemo(() => submittedQueueQueries, [submittedQueueQueries]);
	const visibleQueueCount = queueQueryLines.length;

	const routeSelection = useMemo(() => {
		if (!pathname) return null;
		const query = searchParams?.toString();
		const url = `http://localhost${pathname}${query ? `?${query}` : ''}`;
		return parseDashboardSelectionFromUrl(url);
	}, [pathname, searchParams]);

	const routeSelectionEntityIdKey = useMemo(() => {
		if (!routeSelection) return '';
		return `${routeSelection.entity}:${routeSelection.id}`;
	}, [routeSelection?.entity, routeSelection?.id]);

	const graphHref = useMemo(() => {
		return (
			buildGraphHrefForEntity(currentRecordEntity, currentRecordId) ||
			buildGraphHrefForEntity(routeSelection?.entity, routeSelection?.id) ||
			getLatestGraphHrefFromHistory(localHistory) ||
			'/'
		);
	}, [currentRecordEntity, currentRecordId, routeSelection, localHistory]);

	const handleGraphBackClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			if (typeof window === 'undefined') return;
			event.preventDefault();
			// Bridge Queue graph CRDs via sessionStorage. Prefer the sync seed written when
			// connection Select→Done finishes (avoids React setState race that dropped most of
			// a 100+ multi-select), then fall back to Queue graph history.
			const bridgePayload = readQueueGraphBridgePayload();
			const historyIds = collectSelectedNodeIdsForGraphHref(localHistory);
			const seed = pendingQueueGraphSeed;
			pendingQueueGraphSeed = null;
			const mergedPeople = Array.from(
				new Map(
					[...(bridgePayload?.people || []), ...(seed?.people || [])].map((person) => [String(person.crd), person]),
				).values(),
			);
			const nodeIds = Array.from(new Set([...(seed?.nodeIds || []), ...(bridgePayload?.nodeIds || []), ...historyIds]));
			const firmId = seed?.anchorFirmId || bridgePayload?.anchorFirmId || (currentRecordEntity === 'firm' && currentRecordId ? String(currentRecordId) : undefined);
			const firmName = seed?.anchorFirmName || bridgePayload?.anchorFirmName;
			writeQueueGraphBridge(nodeIds, {
				anchorFirmId: firmId,
				anchorFirmName: firmName,
				people: mergedPeople,
			});
			// Sending the queue to the graph ends this Queue graph session. Returning to the
			// dashboard starts a fresh empty selection history.
			try {
				localStorage.removeItem(LOCAL_HISTORY_KEY);
			} catch {
				/* ignore */
			}
			setLocalHistory([]);
			setSelectedHistoryIds(new Set());
			setIsSelectionHistoryEditMode(false);
			window.location.assign(graphHref || '/');
		},
		[graphHref, localHistory, currentRecordEntity, currentRecordId],
	);

	async function loadNewCrdsFromRedis(force = false) {
		if (!force) {
			const cached = readCachedNewCrds();
			if (cached.length > 0) {
				setNewCrds(cached);
				return;
			}
		}
		try {
			const res = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'list-new-crds', force }),
			});
			const data = await res.json().catch(() => null);
			if (data?.ok) {
				const nextNewCrds = Array.isArray(data.newCrds) ? data.newCrds : [];
				// Debug: surface what the API returned in the client console and on window for inspection
				try {
					console.debug('[dashboard] loadNewCrdsFromRedis: fetched', nextNewCrds);
					// expose temporarily for quick inspection in the browser console
					// eslint-disable-next-line @typescript-eslint/ban-ts-comment
					// @ts-ignore
					window.__NEW_CRDS_PAYLOAD = nextNewCrds;
				} catch (e) {
					// ignore
				}
				setNewCrds(nextNewCrds);
				writeCachedNewCrds(nextNewCrds);
			}
		} catch (err) {
			console.error('Failed to load new CRDs:', err);
		}
	}

	const queueStatusLine = useMemo(() => {
		if (busyAction === 'fetch-crds') {
			const current = crawlProgress?.current ?? 1;
			const total = crawlProgress?.total ?? visibleQueueCount;
			return `Searching | Queue | queue ${current}/${Math.max(1, total)} | elapsed ${queueElapsedSec}s`;
		}
		if (sessionHasFetched) {
			return `Finished | queue - | elapsed ${queueElapsedSec}s`;
		}
		return 'Idle | - | queue - | elapsed 0s';
	}, [busyAction, crawlProgress?.current, crawlProgress?.total, visibleQueueCount, queueElapsedSec, sessionHasFetched]);

	useEffect(() => {
		if (busyAction !== 'fetch-crds') return;

		const timer = window.setInterval(() => {
			setQueueElapsedSec((current) => current + 1);
		}, 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [busyAction]);

	const handleSaveTemplate = () => {
		setIsSavingTemplate(true);
		setNewTemplateName(`Template ${savedTemplates.length + 1}`);
	};

	const handleConfirmSaveTemplate = () => {
		const name = newTemplateName.trim() || `Template ${savedTemplates.length + 1}`;
		const queries = crdInput.trim();
		if (!queries) return;

		const newTemplate: SavedTemplate = {
			id: `${Date.now()}`,
			name,
			queries,
		};
		const updated = [...savedTemplates, newTemplate];
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		setIsSavingTemplate(false);
		setNewTemplateName('');
	};

	const handleDeleteTemplate = (id: string) => {
		const updated = savedTemplates.filter((t) => t.id !== id);
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		if (editingTemplateId === id) {
			setEditingTemplateId(null);
		}
	};

	const handleStartEditTemplate = (tpl: SavedTemplate) => {
		setEditingTemplateId(tpl.id);
		setEditTemplateName(tpl.name);
		setEditTemplateQueries(tpl.queries);
	};

	const handleSaveEditTemplate = (id: string) => {
		const name = editTemplateName.trim() || `Template`;
		const queries = editTemplateQueries.trim();
		if (!queries) return;

		const updated = savedTemplates.map((t) => {
			if (t.id === id) {
				return { ...t, name, queries };
			}
			return t;
		});
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		setEditingTemplateId(null);
	};

	// Load recent CRDs on mount
	useEffect(() => {
		try {
			const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
			if (raw) {
				setLocalHistory(JSON.parse(raw) as LocalHistoryEntry[]);
			}
		} catch (err) {
			console.error('Failed to load local history:', err);
		}

		try {
			const templatesRaw = localStorage.getItem('finra_dashboard_templates');
			if (templatesRaw) {
				setSavedTemplates(JSON.parse(templatesRaw) as SavedTemplate[]);
			}
		} catch (err) {
			console.error('Failed to load saved templates:', err);
		}

		const cached = readCachedNewCrds();
		if (cached.length > 0) {
			setNewCrds(cached);
		}
		void loadNewCrdsFromRedis(false);
	}, []);

	// Collapse the New CRDs panel by default on tablet/mobile viewports; runs once
	// after mount. It also listens to resize events to auto-toggle unless explicitly overridden.
	const toggleNewCrdsOpen = useCallback(() => {
		setNewCrdsOpen((prev) => {
			const next = !prev;
			localStorage.setItem('finra_new_crds_state', next ? 'open' : 'closed');
			return next;
		});
	}, []);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const stored = localStorage.getItem('finra_new_crds_state');
		if (stored === 'open') {
			setNewCrdsOpen(true);
		} else if (stored === 'closed') {
			setNewCrdsOpen(false);
		} else {
			if (window.innerWidth <= 1280) setNewCrdsOpen(false);
		}

		const handleResize = () => {
			if (localStorage.getItem('finra_new_crds_state')) return; // Explicit choice overrides responsive
			setNewCrdsOpen(window.innerWidth > 1280);
		};

		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const intervalId = window.setInterval(() => {
			const cached = readCachedNewCrds();
			if (cached.length > 0) {
				setNewCrds(cached);
				return;
			}
			void loadNewCrdsFromRedis(false);
		}, NEW_CRD_CLIENT_CACHE_TTL_MS);

		return () => window.clearInterval(intervalId);
	}, []);

	const hasCurrentRecord = Boolean(mainJson || result || recordViewLoading);

	useEffect(() => {
		const payload = mainJson || result;
		if (!payload) {
			jsonRenderInFlightKeyRef.current = null;
			setCodeBlock('');
			setJsonTree(null);
			setJsonRenderBusy(false);
			return;
		}

		const cacheKey = mainJson ? `main:${mainJsonLabel}` : `result:${String((result as any)?.ok)}:${String((result as any)?.error || '')}`;
		const cached = jsonStringCacheRef.current.get(cacheKey);
		if (cached != null) {
			jsonRenderInFlightKeyRef.current = null;
			setCodeBlock(cached);
			setJsonRenderBusy(false);
			return;
		}

		if (jsonRenderInFlightKeyRef.current === cacheKey) {
			return;
		}
		jsonRenderInFlightKeyRef.current = cacheKey;

		setJsonRenderBusy(true);
		let cancelled = false;

		const compute = () => {
			if (cancelled) return;
			try {
				const text = renderJsonForDisplay(payload);
				const tree = buildJsonDisplayTree(normalizeRenderablePayload(payload));
				jsonStringCacheRef.current.set(cacheKey, text);
				if (!cancelled) {
					setCodeBlock(text);
					setJsonTree(tree);
				}
			} catch (error: any) {
				if (!cancelled) {
					setCodeBlock(String(error?.message || error || 'Failed to render JSON'));
					setJsonTree(null);
				}
			} finally {
				if (!cancelled) {
					jsonRenderInFlightKeyRef.current = null;
					setJsonRenderBusy(false);
				}
			}
		};

		if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
			const idleId = (window as any).requestIdleCallback(compute, {
				timeout: 180,
			});
			return () => {
				cancelled = true;
				if (jsonRenderInFlightKeyRef.current === cacheKey) {
					jsonRenderInFlightKeyRef.current = null;
				}
				if (typeof (window as any).cancelIdleCallback === 'function') {
					(window as any).cancelIdleCallback(idleId);
				}
			};
		}

		const timeoutId = window.setTimeout(compute, 0);
		return () => {
			cancelled = true;
			if (jsonRenderInFlightKeyRef.current === cacheKey) {
				jsonRenderInFlightKeyRef.current = null;
			}
			window.clearTimeout(timeoutId);
		};
	}, [mainJson, result, mainJsonLabel]);

	// Restore the saved scroll position for the current record once it has finished loading and
	// rendered (or scroll to top the first time a record is viewed). Runs whenever the visible
	// record or its loading state changes so it covers connection-card clicks, browser back/
	// forward navigation, and direct card selection alike.
	useEffect(() => {
		return () => {
			persistDashboardScroll(dashboardContentRef.current);
		};
	}, []);

	useEffect(() => {
		if (recordViewLoading || !currentRecordId || !currentRecordEntity) return;
		const key = `${currentRecordEntity}:${currentRecordId}`;
		// Firm→connection return trip uses the connections-filter anchor instead of raw scrollTop.
		const pendingReturnFirmId = readPendingFirmConnectionsReturn();
		if (skipScrollRestoreForKey === key || (pendingReturnFirmId && pendingReturnFirmId === currentRecordId)) {
			return;
		}
		const target = dashboardScrollPositionsByRecord.get(key) ?? 0;
		const container = dashboardContentRef.current;
		if (!container) return;
		if (target <= 0) {
			container.scrollTop = 0;
			return;
		}

		let cancelled = false;
		let restored = false;
		const apply = () => {
			if (cancelled || restored) return;
			const el = dashboardContentRef.current;
			if (!el) return;
			const max = Math.max(0, el.scrollHeight - el.clientHeight);
			if (max + 1 < target) {
				el.scrollTop = max;
				return;
			}
			el.scrollTop = target;
			restored = true;
		};

		apply();
		const raf = window.requestAnimationFrame(() => {
			apply();
			window.requestAnimationFrame(apply);
		});
		const t1 = window.setTimeout(apply, 50);
		const t2 = window.setTimeout(apply, 250);
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
		ro?.observe(container);
		return () => {
			cancelled = true;
			window.cancelAnimationFrame(raf);
			window.clearTimeout(t1);
			window.clearTimeout(t2);
			ro?.disconnect();
		};
	}, [recordViewLoading, currentRecordId, currentRecordEntity, mainJson]);

	useEffect(() => {
		if (!routeSelection || !routeSelectionEntityIdKey) return;

		const isAlreadySelectedEntity = currentRecordId === routeSelection.id && currentRecordEntity === routeSelection.entity;
		if (isAlreadySelectedEntity) {
			initialRouteLoadDoneRef.current = true;
			return;
		}

		// Only auto-load from the URL on the initial deep link / hard refresh, or in response to
		// a genuine browser back/forward navigation (popNonce change). Any other recomputation of
		// routeSelection is just this effect observing its own syncSelectionToUrl() write and must
		// be ignored, or in-app CRD clicks would fight with this effect forever (see comment near
		// initialRouteLoadDoneRef above).
		const isDeepLinkBootstrap = !initialRouteLoadDoneRef.current;
		const isRealPopNavigation = popNonce !== lastHandledPopNonceRef.current;
		if (!isDeepLinkBootstrap && !isRealPopNavigation) return;
		lastHandledPopNonceRef.current = popNonce;
		initialRouteLoadDoneRef.current = true;

		const activeLoadKey = activeLoadSourceKeyRef.current;
		if (activeLoadKey && activeLoadKey.startsWith(`${routeSelection.entity}:${routeSelection.id}:`)) return;

		const orphanHints =
			routeSelection.entity === 'individual' ? parseOrphanOwnerHintsFromSearchParams(searchParams) : null;
		const card: QueueCard = {
			id: routeSelection.id,
			entity: routeSelection.entity,
			files: Math.max(1, routeSelection.availableSources?.length || 1),
			sources: (routeSelection.availableSources || [routeSelection.source]).map((source) => ({
				source,
				status: 'unknown',
			})),
			orphanHints,
		};

		void loadQueueSourceJson(card, routeSelection.source);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeSelectionEntityIdKey, routeSelection?.source, currentRecordId, currentRecordEntity, popNonce, searchParams]);

	const searchSummary = useMemo(() => {
		if (!searchQuery.trim()) return 'Search saved records by name';
		if (searchBusy) return 'Searching Redis...';
		if (searchError) return searchError;
		if (!searchResults.length) return 'No Redis results yet';
		if (searchSkippedCount > 0) {
			return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found • ${searchSkippedCount} skipped (missing CRD or corrupt)`;
		}
		return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found`;
	}, [searchBusy, searchError, searchQuery, searchResults.length, searchSkippedCount]);

	const searchPaneOpen = useMemo(() => {
		return searchBusy || Boolean(searchError) || hasSearchRun;
	}, [searchBusy, searchError, hasSearchRun]);

	const queueMetaText = useMemo(() => {
		const shown = Number(queueMetaStats.shownCount || queueCards.length || 0);
		const total = Number(queueMetaStats.totalCount || shown);
		const filteredTotal = Number(queueMetaStats.filteredTotalCount || shown);
		const filterSuffix = queueCrdFilter.trim().length > 0 ? ` Filtered: ${filteredTotal.toLocaleString()} matched.${filteredTotal === 0 ? ' (No cached match yet)' : ''}` : '';
		return `Showing recent results from ${shown.toLocaleString()} loaded records (${total.toLocaleString()} total cached records).${filterSuffix}`;
	}, [queueCards.length, queueMetaStats, queueCrdFilter]);

	const persistenceNotice = useMemo(() => {
		if (queueMetaStats.persistenceNotice) return queueMetaStats.persistenceNotice;
		if (queueMetaStats.sourceMode === 'local-fallback') {
			return 'Durable Redis persistence is unavailable here, so recent fetches may be temporary and not reload as saved cache cards.';
		}
		return null;
	}, [queueMetaStats.persistenceNotice, queueMetaStats.sourceMode]);

	const uniqueCrdCounts = useMemo(() => {
		if (queueMetaStats.inventoryTotals) {
			const cached = (queueMetaStats.inventoryTotals as any).cachedCrdCount || 0;
			const cachedParsed = cached && cached !== 'Not Found' && cached !== 'Error' ? parseInt(cached, 10) : NaN;
			return {
				individuals: queueMetaStats.inventoryTotals.people,
				firms: queueMetaStats.inventoryTotals.firms,
				total: !isNaN(cachedParsed) ? cachedParsed : queueMetaStats.inventoryTotals.unique,
				cachedCrdCount: cached,
			};
		}

		const individuals = new Set<string>();
		const firms = new Set<string>();
		queueCards.forEach((card) => {
			if (card.entity === 'individual') {
				individuals.add(card.id);
			} else if (card.entity === 'firm') {
				firms.add(card.id);
			}
		});
		return {
			individuals: individuals.size,
			firms: firms.size,
			total: individuals.size + firms.size,
			cachedCrdCount: undefined as string | number | undefined,
		};
	}, [queueCards, queueMetaStats.inventoryTotals]);

	const hasInventorySummary = useMemo(() => {
		return queueMetaStats.totalCount > 0 || queueMetaStats.totalCacheKeys > 0 || localHistory.length > 0 || uniqueCrdCounts.individuals > 0 || uniqueCrdCounts.firms > 0;
	}, [localHistory.length, queueMetaStats.totalCacheKeys, queueMetaStats.totalCount, uniqueCrdCounts.firms, uniqueCrdCounts.individuals]);

	const historyNameMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const entry of localHistory) {
			if (!entry.name) continue;
			map.set(`${entry.entity}:${entry.id}`, entry.name);
		}
		return map;
	}, [localHistory]);

	const peopleCrdEntries = useMemo(() => {
		return newCrds
			.filter((item) => inferEntityTypeFromNewCrd(item) === 'individual')
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, 16);
	}, [newCrds]);

	const firmCrdEntries = useMemo(() => {
		return newCrds
			.filter((item) => inferEntityTypeFromNewCrd(item) === 'firm')
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, 16);
	}, [newCrds]);

	const orphanRecord = useMemo(() => {
		if (!mainJson || typeof mainJson !== 'object') return null;
		const obj = mainJson as any;
		if (obj.orphan && typeof obj.orphan === 'object') return obj.orphan as Record<string, any>;
		// Flattened non-live payloads (legacy visit-cache / direct redis shapes).
		const looksNonLive =
			String(obj.source || '').includes('form-bd') ||
			String(obj.bcScope || '').toLowerCase().replace(/\s+/g, '') === 'notinscope' ||
			Boolean(obj.parentCrd && (obj.position || obj.firmName) && obj.hasFinraData !== true && obj.hasSecData !== true);
		if (looksNonLive && (obj.parentCrd || obj.firmName || obj.name)) return obj as Record<string, any>;
		return null;
	}, [mainJson]);

	const detailedMainRecord = useMemo(() => {
		if (!mainJson || !currentRecordEntity || !currentRecordId) return null;

		const content = unwrapRecordPayload(mainJson);
		if (!content || typeof content !== 'object') return null;
		const body = content as Record<string, any>;
		const basic = body.basicInformation && typeof body.basicInformation === 'object' ? body.basicInformation : {};

		const mainAddress =
			formatAddress(body.iaFirmAddressDetails?.officeAddress) ||
			formatAddress(body.firmAddressDetails?.officeAddress) ||
			extractCurrentBranchOfficeAddress(body) ||
			formatAddress(body.address) ||
			'Address not found';
		const otherNames = collectOtherNames(basic.otherNames, body.otherNames, basic.aliases, body.aliases);

		const sortEmployment = (arr: any[]) => {
			return arr.sort((a, b) => {
				const getSortDate = (row: any) => {
					const d = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
					return d ? new Date(d).getTime() : 0;
				};
				return getSortDate(b) - getSortDate(a);
			});
		};

		const currentEmployment = sortEmployment(
			mergeEmploymentCardsAcrossSources({
				finra: [...toArray(body.currentEmployments), ...toArray(body.currentEmployment)],
				sec: toArray(body.currentIAEmployments),
			}),
		);
		const previousEmployment = sortEmployment(
			mergeEmploymentCardsAcrossSources({
				finra: toArray(body.previousEmployments),
				sec: toArray(body.previousIAEmployments),
			}),
		);
		const registrationCards = extractRegistrationCards(body);
		const currentConnectionCards = extractConnectionCards(body, 'currentConnections');
		const previousConnectionCards = extractConnectionCards(body, 'previousConnections');

		const stateExams = toArray(body.stateExamCategory).concat(toArray(body.stateExams));
		const productExams = toArray(body.productExamCategory).concat(toArray(body.productExams));
		const principalExams = toArray(body.principalExamCategory).concat(toArray(body.principalExams));

		const registrations = body.registrations && typeof body.registrations === 'object' ? body.registrations : {};
		const registeredSros = Array.from(
			new Set(
				toArray(body.registeredSROs)
					.map((row: any) => String(row?.sro || '').trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b));

		const additionalDetails: Array<{ label: string; value: string }> = [];
		for (const [key, value] of Object.entries(basic)) {
			if (DETAIL_SKIP_KEYS.has(key) || isEmptyRawValue(value)) continue;
			const rendered = stringifyRawValue(value);
			if (!rendered) continue;
			const label = humanizeKey(key);
			if (shouldHideDetailLabel(label)) continue;
			additionalDetails.push({ label, value: rendered });
		}
		for (const [key, value] of Object.entries(body)) {
			if (DETAIL_SKIP_KEYS.has(key) || isEmptyRawValue(value)) continue;
			const rendered = stringifyRawValue(value);
			if (!rendered) continue;
			const label = humanizeKey(key);
			if (shouldHideDetailLabel(label)) continue;
			additionalDetails.push({ label, value: rendered });
		}

		const mainObj = typeof mainJson === 'object' && mainJson !== null ? (mainJson as any) : {};
		const showFinra =
			mainObj.hasFinraData === true ? true
			: mainObj.hasFinraData === false ? false
			: currentRecordEntity === 'individual' ? hasIndividualSourceCoverage(body, 'finra')
			: hasFirmSourceCoverage(body, 'finra');
		const showSec =
			mainObj.hasSecData === true ? true
			: mainObj.hasSecData === false ? false
			: currentRecordEntity === 'individual' ? hasIndividualSourceCoverage(body, 'sec')
			: hasFirmSourceCoverage(body, 'sec');

		const profileLinks: Array<{
			label: string;
			href: string;
			source: 'finra' | 'sec';
		}> = [];
		if (showFinra) {
			profileLinks.push({
				label: 'FINRA profile ↗',
				href: `https://brokercheck.finra.org/${currentRecordEntity === 'firm' ? 'firm' : 'individual'}/summary/${currentRecordId}`,
				source: 'finra',
			});
			if (currentRecordEntity === 'individual') {
				profileLinks.push({
					label: 'FINRA Detailed Report (PDF) ↗',
					href: `https://files.brokercheck.finra.org/individual/individual_${currentRecordId}.pdf`,
					source: 'finra',
				});
			}
		}
		if (showSec) {
			profileLinks.push({
				label: 'SEC profile ↗',
				href: `https://adviserinfo.sec.gov/${currentRecordEntity === 'firm' ? 'firm' : 'individual'}/summary/${currentRecordId}`,
				source: 'sec',
			});
		}

		const jurisdictionCards = extractJurisdictionCards(body);
		const brochureCards = extractBrochureCards(body);
		const documentLinkCards = extractDocumentLinkCards(body);
		const noticeFilingCards = extractNoticeFilingsCards(body);

		const crs = (body.crs || body.Crs || body.CRS) && typeof (body.crs || body.Crs || body.CRS) === 'object' ? body.crs || body.Crs || body.CRS : null;
		const affiliateDisclosures =
			(body.affiliateDisclosures || body['Affiliate Disclosures']) && typeof (body.affiliateDisclosures || body['Affiliate Disclosures']) === 'object' ?
				body.affiliateDisclosures || body['Affiliate Disclosures']
			:	null;
		const bdDisclosureFlag = pickFirstNonEmpty(body.bdDisclosureFlag, body.bd_disclosure_flag, basic.bdDisclosureFlag);
		const iaDisclosureFlag = pickFirstNonEmpty(body.iaDisclosureFlag, body.ia_disclosure_flag, basic.iaDisclosureFlag);
		const brochuresPart2Exempt = pickFirstNonEmpty(body.brochures?.part2ExemptFlag, body.part2ExemptFlag);

		const bcScope = pickFirstNonEmpty(basic.bcScope, body.bcScope, basic.brokerCheckScope, body.brokerCheckScope, body.bc_scope);
		const iaScope = pickFirstNonEmpty(basic.iaScope, body.iaScope, basic.secScope, body.secScope, body.ia_scope);
		let finraActive =
			!showFinra ? ''
			: bcScope ? `FINRA: ${bcScope}`
			: 'FINRA: Active';
		const secActive =
			!showSec ? ''
			: iaScope ? `SEC: ${iaScope}`
			: 'SEC: Active';
			
		if (!showFinra && !showSec) {
			finraActive = 'Historical Record (No Live Data)';
		}
		
		const subtitle = otherNames.length > 0 && currentRecordEntity === 'individual' ? otherNames[0] : '';

		const directOwners = toArray(body.directOwners).concat(toArray(body.directOwnersExecutiveOfficers));
		const indirectOwners = toArray(body.indirectOwners);

		// Build a compact disclosure summary when available (e.g. FINRA firm disclosures or individual event details)
		const groupedDisclosures = new Map<string, number>();
		if (Array.isArray(body.disclosures)) {
			for (const d of body.disclosures) {
				const type = String(d?.disclosureType || d?.type || d?.disclosure || '').trim();
				if (!type) continue;
				const count = Number(d?.disclosureCount ?? d?.count ?? 0);
				const increment = count > 0 ? count : 1;
				groupedDisclosures.set(type, (groupedDisclosures.get(type) || 0) + increment);
			}
		}
		if (Array.isArray(body.iaDisclosures)) {
			for (const d of body.iaDisclosures) {
				const type = String(d?.disclosureType || d?.type || d?.disclosure || '').trim();
				if (!type) continue;
				const count = Number(d?.disclosureCount ?? d?.count ?? 0);
				const increment = count > 0 ? count : 1;
				groupedDisclosures.set(type, (groupedDisclosures.get(type) || 0) + increment);
			}
		}
		const disclosureSummary = Array.from(groupedDisclosures.entries()).map(([disclosureType, disclosureCount]) => ({
			disclosureType,
			disclosureCount,
		}));

		return {
			name:
				pickFirstNonEmpty(basic.iaFirmName, basic.firmName, basic.fullName, basic.individualName) ||
				extractEntityDetailFromPayload(content, currentRecordEntity, currentRecordId)?.name ||
				`${currentRecordEntity === 'firm' ? 'Firm' : 'Individual'} ${currentRecordId}`,
			subtitle,
			hasFinraData: showFinra,
			hasSecData: showSec,
			finraActive,
			secActive,
			mainAddress,
			otherNames,
			profileLinks,
			currentEmployment,
			previousEmployment,
			registrationCards,
			currentConnectionCards,
			previousConnectionCards,
			stateExams,
			productExams,
			principalExams,
			registrations,
			registeredSros,
			additionalDetails,
			jurisdictionCards,
			brochureCards,
			documentLinkCards,
			noticeFilingCards,
			crs,
			affiliateDisclosures,
			bdDisclosureFlag,
			iaDisclosureFlag,
			brochuresPart2Exempt,
			basicInformation: basic,
			directOwners,
			indirectOwners,
			disclosureSummary,
			rawDisclosures: Array.isArray(body.disclosures) ? body.disclosures : [],
		};
	}, [mainJson, currentRecordEntity, currentRecordId]);

	// Firm "other names" for Current/Previous Employment rows, keyed by CRD, fetched lazily.
	const employmentFirmCrds = useMemo(() => {
		const ids = new Set<string>();
		if (detailedMainRecord) {
			for (const row of detailedMainRecord.currentEmployment) {
				const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
				if (crd) ids.add(String(crd));
			}
			for (const row of detailedMainRecord.previousEmployment) {
				const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
				if (crd) ids.add(String(crd));
			}
		}
		// Non-live / orphan people: hydrate the parent firm card the same way as coworker employment rows.
		const orphanParent = pickFirstValidCrd(
			(mainJson as any)?.orphan?.parentCrd,
			(mainJson as any)?.parentCrd,
			orphanRecord?.parentCrd,
		);
		const orphanParentType = String(
			(mainJson as any)?.orphan?.parentType || (mainJson as any)?.parentType || orphanRecord?.parentType || 'firm',
		)
			.trim()
			.toLowerCase();
		if (orphanParent && orphanParentType !== 'individual') ids.add(orphanParent);
		return Array.from(ids);
	}, [detailedMainRecord, mainJson, orphanRecord]);
	const employmentFirmInfo = useFirmInfoByCrd(employmentFirmCrds);

	const connectionFilterPreviewUnfiltered = shouldPreviewUnfilteredConnections({
		focused: connectionsFilterFocused,
		liveText: connectionsFilterQuery,
		justCommitted: connectionsFilterJustCommitted,
	});
	const [currentRenderCount, setCurrentRenderCount] = useState(CONNECTION_PAGE_SIZE);
	const [previousRenderCount, setPreviousRenderCount] = useState(CONNECTION_PAGE_SIZE);
	const connectionsFilterActive = Boolean(connectionsFilterQuery.trim()) || (connectionsFilterEnabled && connectionsFilterTags.length > 0);
	const connectionPageSize = connectionsFilterActive ? CONNECTION_FILTER_PAGE_SIZE : CONNECTION_PAGE_SIZE;
	const loadMoreCurrentConnections = useCallback(() => {
		setCurrentRenderCount((count) => count + CONNECTION_FILTER_PAGE_SIZE);
	}, []);
	const loadMorePreviousConnections = useCallback(() => {
		setPreviousRenderCount((count) => count + CONNECTION_FILTER_PAGE_SIZE);
	}, []);

	// Defer live typing so keystrokes stay responsive on large firm connection lists.
	const deferredCurrentConnectionCards = useDeferredValue(detailedMainRecord?.currentConnectionCards || []);
	const deferredCurrentFilterTags = useDeferredValue(connectionsFilterTags);
	const deferredCurrentFilterQuery = useDeferredValue(connectionsFilterQuery);
	const deferredCurrentFilterEnabled = useDeferredValue(connectionsFilterEnabled);
	const deferredCurrentPreviewUnfiltered = useDeferredValue(connectionFilterPreviewUnfiltered);
	const connectionHaystackOf = useCallback(
		(item: { haystack?: string; title?: string; meta?: string; crd?: string; statusTag?: string; sourceTags?: string[]; otherNames?: string[] }) =>
			item.haystack ||
			[item.title, item.meta, item.crd, item.statusTag, ...(item.sourceTags || []), ...(item.otherNames || [])].filter(Boolean).join(' '),
		[],
	);
	const currentConnectionPartition = useMemo(() => {
		return partitionConnectionsByFilter(
			deferredCurrentConnectionCards,
			(item) => connectionHaystackOf(item),
			deferredCurrentFilterTags,
			deferredCurrentFilterQuery.trim(),
			deferredCurrentFilterEnabled,
			deferredCurrentPreviewUnfiltered,
		);
	}, [
		deferredCurrentConnectionCards,
		connectionHaystackOf,
		deferredCurrentFilterTags,
		deferredCurrentFilterQuery,
		deferredCurrentFilterEnabled,
		deferredCurrentPreviewUnfiltered,
	]);
	const filteredCurrentConnectionCardsAll = useMemo(() => {
		const filterActive =
			!deferredCurrentPreviewUnfiltered &&
			(Boolean(deferredCurrentFilterQuery.trim()) || (deferredCurrentFilterEnabled && deferredCurrentFilterTags.length > 0));
		// Keep relevance order from partitionConnectionsByFilter when filtering; otherwise newest first.
		if (filterActive) return currentConnectionPartition.ordered;
		return [...sortByMostRecentStartDate(currentConnectionPartition.matched), ...sortByMostRecentStartDate(currentConnectionPartition.unmatched)];
	}, [
		currentConnectionPartition,
		deferredCurrentFilterEnabled,
		deferredCurrentPreviewUnfiltered,
		deferredCurrentFilterTags,
		deferredCurrentFilterQuery,
	]);
	const filteredCurrentConnectionCards = useMemo(() => filteredCurrentConnectionCardsAll.slice(0, currentRenderCount), [filteredCurrentConnectionCardsAll, currentRenderCount]);

	const deferredPreviousConnectionCards = useDeferredValue(detailedMainRecord?.previousConnectionCards || []);
	const deferredPreviousFilterTags = useDeferredValue(connectionsFilterTags);
	const deferredPreviousFilterQuery = useDeferredValue(connectionsFilterQuery);
	const deferredPreviousFilterEnabled = useDeferredValue(connectionsFilterEnabled);
	const deferredPreviousPreviewUnfiltered = useDeferredValue(connectionFilterPreviewUnfiltered);
	const previousConnectionPartition = useMemo(() => {
		return partitionConnectionsByFilter(
			deferredPreviousConnectionCards,
			(item) => connectionHaystackOf(item),
			deferredPreviousFilterTags,
			deferredPreviousFilterQuery.trim(),
			deferredPreviousFilterEnabled,
			deferredPreviousPreviewUnfiltered,
		);
	}, [
		deferredPreviousConnectionCards,
		connectionHaystackOf,
		deferredPreviousFilterTags,
		deferredPreviousFilterQuery,
		deferredPreviousFilterEnabled,
		deferredPreviousPreviewUnfiltered,
	]);
	const filteredPreviousConnectionCardsAll = previousConnectionPartition.ordered;
	useEffect(() => {
		setCurrentRenderCount(connectionPageSize);
		setPreviousRenderCount(connectionPageSize);
	}, [
		currentRecordId,
		deferredPreviousFilterQuery,
		deferredPreviousFilterTags,
		deferredPreviousFilterEnabled,
		connectionsFilterQuery,
		connectionsFilterTags,
		connectionsFilterEnabled,
		connectionPageSize,
	]);
	const filteredPreviousConnectionCards = useMemo(
		() => filteredPreviousConnectionCardsAll.slice(0, previousRenderCount),
		[filteredPreviousConnectionCardsAll, previousRenderCount],
	);

	// One-shot return: firm → connection → person → same firm card scrolls to the connections filter.
	useEffect(() => {
		if (recordViewLoading || currentRecordEntity !== 'firm' || !currentRecordId) return;
		const pendingFirmId = readPendingFirmConnectionsReturn();
		if (!pendingFirmId || pendingFirmId !== currentRecordId) return;

		const stillLoadingConnections =
			connectionsLoadingFirmId === currentRecordId &&
			(detailedMainRecord?.currentConnectionCards.length || 0) === 0 &&
			(detailedMainRecord?.previousConnectionCards.length || 0) === 0;
		if (stillLoadingConnections) return;

		let cancelled = false;
		let done = false;
		const tryScroll = () => {
			if (cancelled || done) return;
			const el = document.getElementById(FIRM_CONNECTIONS_ANCHOR_ID);
			if (!el) return;
			const preferred = dashboardContentRef.current;
			const container = preferred && preferred.scrollHeight > preferred.clientHeight + 1 ? preferred : getScrollParent(el);
			if (!container || container.scrollHeight <= container.clientHeight + 1) return;

			const containerRect = container.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			const nextTop = container.scrollTop + (elRect.top - containerRect.top) - 16;
			container.scrollTop = Math.max(0, nextTop);

			const afterRect = el.getBoundingClientRect();
			if (afterRect.top > containerRect.top + 48) return;

			dashboardScrollPositionsByRecord.set(`firm:${currentRecordId}`, container.scrollTop);
			writePendingFirmConnectionsReturn(null);
			if (skipScrollRestoreForKey === `firm:${currentRecordId}`) {
				skipScrollRestoreForKey = null;
			}
			done = true;
		};
		tryScroll();
		const raf = window.requestAnimationFrame(() => {
			tryScroll();
			window.requestAnimationFrame(tryScroll);
		});
		const timers = [50, 150, 350, 800, 1600, 3000].map((ms) => window.setTimeout(tryScroll, ms));
		const giveUp = window.setTimeout(() => {
			if (done || cancelled) return;
			writePendingFirmConnectionsReturn(null);
			if (skipScrollRestoreForKey === `firm:${currentRecordId}`) skipScrollRestoreForKey = null;
		}, 5000);
		return () => {
			cancelled = true;
			window.cancelAnimationFrame(raf);
			for (const timer of timers) window.clearTimeout(timer);
			window.clearTimeout(giveUp);
		};
	}, [
		recordViewLoading,
		currentRecordId,
		currentRecordEntity,
		mainJson,
		connectionsLoadingFirmId,
		detailedMainRecord?.currentConnectionCards.length,
		detailedMainRecord?.previousConnectionCards.length,
	]);

	const additionalDetailsSourceLabel = useMemo(() => {
		if (!mainJson || typeof mainJson !== 'object') {
			return currentRecordSource ? String(currentRecordSource).toUpperCase() : '';
		}

		const payload = mainJson as Record<string, any>;
		const hasFinraData = payload.hasFinraData === true;
		const hasSecData = payload.hasSecData === true;

		if (!hasFinraData && hasSecData) return 'SEC';
		if (hasFinraData && !hasSecData) return 'FINRA';

		return currentRecordSource ? String(currentRecordSource).toUpperCase() : '';
	}, [mainJson, currentRecordSource]);

	const displayCards = useMemo<QueueCard[]>(() => {
		const token = queueCrdFilter.trim();
		const tokens =
			token ?
				token
					.split(/[\s,;]+/g)
					.map((v) => v.trim())
					.filter(Boolean)
			:	[];
		const filtered = tokens.length ? localHistory.filter((e) => tokens.some((t) => e.id === t || e.id.includes(t))) : localHistory;
		// No cap: Queue graph selection history can grow without truncating the list.
		return filtered
			.slice()
			.sort((a, b) => new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime())
			.map((e) => ({
				id: e.id,
				entity: e.entity,
				files: e.sources.length,
				sources: e.sources,
				name: e.name ?? null,
				kind: 'recent' as const,
				since: new Date(e.fetchedAt).toLocaleString(),
			}));
	}, [localHistory, queueCrdFilter]);

	const filteredNewCrds = useMemo(() => {
		const token = queueCrdFilter.trim();
		if (!token) return [] as Array<(typeof newCrds)[number]>;
		const tokens = token
			.split(/[\s,;]+/g)
			.map((value) => value.trim())
			.filter(Boolean);
		return newCrds.filter((item) => tokens.some((value) => item.id === value || item.id.includes(value)));
	}, [newCrds, queueCrdFilter]);

	function markRecordUpdatedAt(value?: unknown) {
		const raw = typeof value === 'string' ? value.trim() : '';
		if (raw) {
			setRecordUpdatedAt(raw);
			return;
		}
		setRecordUpdatedAt(new Date().toISOString());
	}

	function extractValidCrd(item: SearchResult, entity: 'individual' | 'firm') {
		const candidateKeys =
			entity === 'individual' ?
				['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id']
			:	['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

		for (const key of candidateKeys) {
			const raw = item?.[key];
			if (raw == null) continue;
			const value = String(raw).trim();
			if (/^\d{1,10}$/.test(value)) return value;
		}

		return '';
	}

	function isCorruptSearchItem(item: unknown) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
		const obj = item as SearchResult;
		const hasSignalField = [
			obj.individualId,
			obj.firmId,
			obj.crd,
			obj.ind_crd,
			obj.firm_crd,
			obj.ind_source_id,
			obj.firm_source_id,
			obj.name,
			obj.fullName,
			obj.firmName,
			obj.status,
		].some((value) => value != null && String(value).trim().length > 0);
		return !hasSignalField;
	}

	function recordHistoryEntry({
		id,
		entity,
		source,
		sources,
		name,
	}: {
		id: string;
		entity: 'individual' | 'firm';
		source?: SearchResultSource;
		sources?: SearchResultSource[];
		name?: string;
	}) {
		if (typeof window === 'undefined') return;
		const now = new Date().toISOString();
		const incomingName = toText(name);
		const incomingSources: SearchResultSource[] =
			sources && sources.length > 0 ? sources
			: source ? [source]
			: ['finra'];
		setLocalHistory((prev) => {
			const nextEntries = prev.filter((entry) => !(entry.entity === entity && entry.id === id));
			const existing = prev.find((entry) => entry.entity === entity && entry.id === id);
			const existingName = toText(existing?.name);
			const resolvedName =
				incomingName && !looksLikeGenericEntityLabel(incomingName) ? incomingName
				: existingName && !looksLikeGenericEntityLabel(existingName) ? existingName
				: incomingName || existingName || undefined;

			const updatedEntry: LocalHistoryEntry = {
				id,
				entity,
				// Replace rather than merge: incomingSources reflects freshly-validated coverage,
				// so stale/incorrect source tags from earlier visits must not persist.
				sources: incomingSources.map((src) => ({
					source: src,
					status: 'ok' as const,
				})),
				fetchedAt: existing?.fetchedAt || now,
				name: resolvedName,
				visitCount: (existing?.visitCount || 0) + 1,
				lastVisitedAt: now,
			};

			const combined = [updatedEntry, ...nextEntries].slice(0, LOCAL_HISTORY_MAX);
			try {
				localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(combined));
			} catch {
				// ignore persistence errors
			}
			return combined;
		});
	}

	function recordHistoryEntries(
		entries: Array<{
			id: string;
			entity: 'individual' | 'firm';
			source?: SearchResultSource;
			sources?: SearchResultSource[];
			name?: string;
		}>,
	) {
		if (typeof window === 'undefined' || !entries.length) return;
		const now = new Date().toISOString();
		setLocalHistory((prev) => {
			let next = prev.slice();
			// Process last-to-first so the first visible selected row ends up at the front.
			for (const item of [...entries].reverse()) {
				const id = String(item.id || '').trim();
				if (!id) continue;
				const incomingName = toText(item.name);
				const incomingSources: SearchResultSource[] =
					item.sources && item.sources.length > 0 ? item.sources
					: item.source ? [item.source]
					: ['finra', 'sec'];
				const existing = next.find((entry) => entry.entity === item.entity && entry.id === id);
				const existingName = toText(existing?.name);
				const resolvedName =
					incomingName && !looksLikeGenericEntityLabel(incomingName) ? incomingName
					: existingName && !looksLikeGenericEntityLabel(existingName) ? existingName
					: incomingName || existingName || undefined;
				const updatedEntry: LocalHistoryEntry = {
					id,
					entity: item.entity,
					sources: incomingSources.map((src) => ({
						source: src,
						status: 'ok' as const,
					})),
					fetchedAt: existing?.fetchedAt || now,
					name: resolvedName,
					visitCount: (existing?.visitCount || 0) + 1,
					lastVisitedAt: now,
				};
				next = [updatedEntry, ...next.filter((entry) => !(entry.entity === item.entity && entry.id === id))];
			}
			const combined = next.slice(0, LOCAL_HISTORY_MAX);
			try {
				localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(combined));
			} catch {
				// ignore persistence errors
			}
			return combined;
		});
	}

	async function setMainViewFromSearch(card: SearchResultCard) {
		const orderedSources: SearchResultSource[] =
			card.availableSources && card.availableSources.length > 0 ? card.availableSources
			: card.source === 'sec' ? ['sec', 'finra']
			: ['finra', 'sec'];
		await loadQueueSourceJson(
			{
				id: card.id,
				entity: card.entity,
				files: orderedSources.length,
				sources: orderedSources.map((source) => ({
					source,
					status: 'unknown',
				})),
				name: card.label || null,
			},
			card.source,
		);
	}

	async function openHistoryEntry(entry: LocalHistoryEntry) {
		const primarySource = entry.sources.find((item) => item.source === 'finra')?.source || entry.sources[0]?.source || 'finra';
		await loadQueueSourceJson(
			{
				id: entry.id,
				entity: entry.entity,
				files: entry.sources.length,
				sources: entry.sources,
				name: entry.name ?? null,
			},
			primarySource,
		);
	}

	function clearSelectionHistory() {
		setLocalHistory([]);
		if (typeof window !== 'undefined') {
			try {
				localStorage.removeItem(LOCAL_HISTORY_KEY);
			} catch {
				// ignore localStorage errors
			}
		}
	}

	function toggleSelectionHistoryEditMode() {
		setIsSelectionHistoryEditMode((prev) => !prev);
		setSelectedHistoryIds(new Set());
	}

	function toggleSelectedHistoryId(id: string) {
		setSelectedHistoryIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function deleteSelectedHistoryEntries() {
		if (!selectedHistoryIds.size) return;
		setLocalHistory((prev) => {
			const next = prev.filter((entry) => !selectedHistoryIds.has(`${entry.entity}:${entry.id}`));
			if (typeof window !== 'undefined') {
				try {
					localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(next));
				} catch {
					// ignore localStorage errors
				}
			}
			return next;
		});
		setSelectedHistoryIds(new Set());
	}

	async function openQueueCard(card: QueueCard) {
		const preferredSource = card.sources.find((entry) => entry.source === 'finra')?.source || card.sources[0]?.source || 'finra';
		await loadQueueSourceJson(card, preferredSource);
	}

	async function openNewCrdEntry(entry: NewCrdEntry) {
		const entity: 'individual' | 'firm' = inferEntityTypeFromNewCrd(entry);
		const historyMatch = localHistory.find((item) => item.entity === entity && item.id === entry.id);
		if (historyMatch) {
			await openHistoryEntry(historyMatch);
			return;
		}

		const sources: QueueCardSourceEntry[] = [];
		const scopeText = (entry.scopes || []).join(' ').toLowerCase();
		if (scopeText.includes('finra') || scopeText.includes('bc')) sources.push({ source: 'finra', status: 'unknown' });
		if (scopeText.includes('sec') || scopeText.includes('ia')) sources.push({ source: 'sec', status: 'unknown' });
		// If scopes didn't declare any source (unexpected), default to attempting FINRA first;
		// the real tags are recomputed from validated payload coverage after fetch, not from this guess.
		if (sources.length === 0) sources.push({ source: 'finra', status: 'unknown' });

		await loadQueueSourceJson(
			{
				id: entry.id,
				entity,
				files: sources.length,
				sources,
				name: historyNameMap.get(`${entity}:${entry.id}`) || extractDisplayNameFromNewCrd(entry, entity),
			},
			sources[0].source,
		);
	}

	function syncSelectionToUrl({ entity, id, source, availableSources = [source] }: UrlSelectionInput) {
		if (typeof window === 'undefined') return;
		const normalizedId = normalizeCrd(id);
		if (!normalizedId) return;

		const recordId = normalizedId;

		const nextPath = `/dashboard/${entity}/${encodeURIComponent(recordId)}`;
		if (window.location.pathname === nextPath) return;
		window.history.pushState({}, '', nextPath);
	}

	function isSelectedCardSource(card: QueueCard, source: SearchResultSource) {
		return currentRecordId === card.id && currentRecordEntity === card.entity && currentRecordSource === source;
	}

	function handleInternalDashboardLinkClick(event: MouseEvent<HTMLElement>) {
		const target = event.target as HTMLElement | null;
		const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
		if (!anchor) return;

		const rawHref = String(anchor.getAttribute('href') || '').trim();
		if (!rawHref) return;

		let hrefForParsing = rawHref;
		try {
			if (typeof window !== 'undefined') {
				const resolved = new URL(rawHref, window.location.origin);
				if (!resolved.pathname.startsWith('/dashboard/')) return;
				hrefForParsing = `${resolved.pathname}${resolved.search}${resolved.hash}`;
			} else if (!rawHref.startsWith('/dashboard/')) {
				return;
			}
		} catch {
			if (!rawHref.startsWith('/dashboard/')) return;
		}

		const parsed = parseDashboardSelectionFromUrl(`http://localhost${hrefForParsing}`);
		if (!parsed) return;

		event.preventDefault();
		event.stopPropagation();

		// Leaving a firm via a connection card: on return to this firm, scroll to the connections filter.
		if (currentRecordEntity === 'firm' && currentRecordId && parsed.entity === 'individual') {
			writePendingFirmConnectionsReturn(currentRecordId);
			skipScrollRestoreForKey = `firm:${currentRecordId}`;
			dashboardScrollPositionsByRecord.delete(`firm:${currentRecordId}`);
		}

		const orderedSources: SearchResultSource[] = parsed.source === 'sec' ? ['sec', 'finra'] : ['finra', 'sec'];
		let orphanHints: DashboardOrphanOwnerHints | null = null;
		try {
			const resolved = new URL(hrefForParsing, 'http://localhost');
			orphanHints = parseOrphanOwnerHintsFromSearchParams(resolved.searchParams);
		} catch {
			orphanHints = null;
		}

		const card: QueueCard = {
			id: parsed.id,
			entity: parsed.entity,
			files: orderedSources.length,
			sources: orderedSources.map((source) => ({ source, status: 'unknown' })),
			orphanHints,
		};

		void loadQueueSourceJson(card, parsed.source);
	}

	async function loadInventoryOnlyFromRedis() {
		try {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'list-cache-cards',
					maxCards: 1,
					crdFilter: '',
				}),
			});
			const payload = await response.json().catch(() => null);
			if (payload?.inventoryTotals) {
				setQueueMetaStats((current) => ({
					...current,
					inventoryTotals: payload.inventoryTotals,
				}));
			}
		} catch {
			// ignore on mount
		}
	}

	async function loadQueueCardsFromRedis(filter = '') {
		try {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'list-cache-cards',
					maxCards: filter.trim() ? 200 : 20,
					crdFilter: filter,
				}),
			});

			const payload = await response.json().catch(() => null);
			if (payload?.ok === false) {
				setQueueCards([]);
				setQueueMetaStats({
					shownCount: 0,
					totalCount: 0,
					totalCacheKeys: 0,
					filteredTotalCount: 0,
					persistenceNotice: null,
				});
				return;
			}

			const cards = Array.isArray(payload?.cards) ? payload.cards : [];
			setQueueCards((current) => {
				const sourceMode = String(payload?.sourceMode || '');
				if (cards.length === 0 && sourceMode === 'local-fallback' && current.length > 0) {
					return current;
				}
				return cards as QueueCard[];
			});
			setQueueMetaStats({
				shownCount: Number(payload?.shownCount || cards.length || 0),
				totalCount: Number(payload?.totalCount || cards.length || 0),
				totalCacheKeys: Number(payload?.totalCacheKeys || 0),
				...(payload?.filteredTotalCount != null ? { filteredTotalCount: Number(payload.filteredTotalCount || 0) } : {}),
				...(payload?.sourceMode ? { sourceMode: String(payload.sourceMode) } : {}),
				...(payload?.persistenceNotice !== undefined ?
					{
						persistenceNotice: payload.persistenceNotice ? String(payload.persistenceNotice) : null,
					}
				:	{}),
				...(payload?.inventoryTotals ? { inventoryTotals: payload.inventoryTotals } : {}),
			});
		} catch {
			// keep existing cards on load errors
		}
	}

	useEffect(() => {
		void loadInventoryOnlyFromRedis();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!sessionHasFetched && !queueCrdFilter.trim()) return;

		void loadQueueCardsFromRedis(queueCrdFilter);

		const intervalId = setInterval(() => {
			void loadQueueCardsFromRedis(queueCrdFilter);
		}, QUEUE_CARD_LIST_POLL_MS);

		return () => clearInterval(intervalId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queueCrdFilter, sessionHasFetched]);

	function addCardsToLocalHistory(results: any[]) {
		if (typeof window === 'undefined') return;
		const now = new Date().toISOString();
		const map = new Map<string, LocalHistoryEntry>();

		for (const r of results) {
			if (r?.status !== 'ok') continue;
			if (!r?.newRecordSaved && !r?.newSourceSaved) continue;
			const id = String(r?.crd || '').trim();
			const entity: 'individual' | 'firm' = String(r?.type || '').toLowerCase() === 'firm' ? 'firm' : 'individual';
			const source = String(r?.source || '').toLowerCase() as SearchResultSource;
			if (!/^\d{1,10}$/.test(id)) continue;
			if (source !== 'finra' && source !== 'sec') continue;

			const key = `${entity}:${id}`;
			const existing = map.get(key) ?? {
				id,
				entity,
				sources: [],
				fetchedAt: now,
			};
			const srcIdx = existing.sources.findIndex((s) => s.source === source);
			const srcEntry: QueueCardSourceEntry = { source, status: 'ok' };
			if (srcIdx >= 0) existing.sources[srcIdx] = srcEntry;
			else existing.sources.push(srcEntry);
			// Keep the first non-empty name we find across sources
			if (!existing.name && r?.name) existing.name = String(r.name).trim() || undefined;
			map.set(key, existing);
		}

		if (!map.size) return;

		setLocalHistory((prev) => {
			const newEntries = Array.from(map.values());
			const prevFiltered = prev.filter((e) => !map.has(`${e.entity}:${e.id}`));
			const combined = [...newEntries, ...prevFiltered].slice(0, LOCAL_HISTORY_MAX);
			try {
				localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(combined));
			} catch {
				/* ignore */
			}
			return combined;
		});
	}

	function isUsableMergedDetailCache(value: unknown): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
		const record = value as Record<string, any>;
		if (record.found === false) return false;
		return Boolean(record.orphan || record.basicInformation || record.merged || record.finraNode || record.hits || record.bccontent || record.iacontent);
	}

	async function fetchMergedDetail(card: QueueCard) {
		const cacheKey = `${card.entity}:${card.id}`;
		const cached = mergedDetailCacheRef.current.get(cacheKey) || readVisitedSync(visitDetailKey(card.entity, card.id));
		if (isUsableMergedDetailCache(cached)) return cached;
		// Stale found:false visit-cache must not block orphan synthesis from parent-firm hints.
		if (cached && (cached as any).found === false) {
			mergedDetailCacheRef.current.delete(cacheKey);
		}
		const persisted = await readVisited(visitDetailKey(card.entity, card.id));
		if (isUsableMergedDetailCache(persisted)) {
			mergedDetailCacheRef.current.set(cacheKey, persisted);
			return persisted;
		}

		const baseRoute =
			card.entity === 'firm' ? `/api/finra/firm/${card.id}?merged=1` : `/api/finra/individual/${card.id}?merged=1&includePrevious=true`;
		const route = card.entity === 'individual' ? appendOrphanHintsToIndividualApiUrl(baseRoute, card.orphanHints) : baseRoute;
		try {
			const response = await fetch(route, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				cache: 'default',
			});
			if (!response.ok) {
				return { found: false, error: `HTTP ${response.status}` };
			}
			let detail = await response.json();
			if (card.entity === 'individual' && detail?.found === false && card.orphanHints?.parentCrd) {
				detail = buildOrphanIndividualPayloadFromHints(card.id, card.orphanHints) || detail;
			}
			if (detail && typeof detail === 'object' && detail.found !== false) {
				mergedDetailCacheRef.current.set(cacheKey, detail);
				rememberVisited(visitDetailKey(card.entity, card.id), detail);
			}
			return detail;
		} catch (err: any) {
			if (card.entity === 'individual' && card.orphanHints?.parentCrd) {
				const synthesized = buildOrphanIndividualPayloadFromHints(card.id, card.orphanHints);
				if (synthesized) return synthesized;
			}
			return { found: false, error: err?.message || String(err) };
		}
	}

	async function fetchFallbackDetail(card: QueueCard) {
		const baseRoute =
			card.entity === 'firm' ? `/api/finra/firm/${card.id}?merged=1` : `/api/finra/individual/${card.id}?merged=1&includePrevious=true`;
		const route = card.entity === 'individual' ? appendOrphanHintsToIndividualApiUrl(baseRoute, card.orphanHints) : baseRoute;

		const response = await fetch(route, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'default',
		});

		const detail = await response.json().catch(() => null);
		if (card.entity === 'individual' && detail?.found === false && card.orphanHints?.parentCrd) {
			return buildOrphanIndividualPayloadFromHints(card.id, card.orphanHints) || detail;
		}
		return detail;
	}

	function mergeFirmConnectionLists(lists: any[][]) {
		const connectionRichness = (entry: any) => {
			let score = 0;
			if (entry?.name) score += 1;
			if (entry?.startDate || entry?.registrationBeginDate) score += 3;
			if (entry?.endDate || entry?.registrationEndDate) score += 1;
			if (entry?.address) score += 3;
			if (Array.isArray(entry?.otherNames) && entry.otherNames.length) score += 3;
			return score;
		};
		const currentByKey = new Map<string, any>();
		const previousByKey = new Map<string, any>();
		for (const list of lists) {
			for (const entry of Array.isArray(list) ? list : []) {
				const crd = String(entry?.individualId || entry?.crd || entry?.personCrd || entry?.firmId || '').trim();
				if (!crd) continue;
				const isCurrent =
					entry?.isCurrent === true ? true
					: entry?.isCurrent === false ? false
					: !String(entry?.endDate || '').trim();
				const key = `${crd}:${isCurrent ? '1' : '0'}`;
				const bucket = isCurrent ? currentByKey : previousByKey;
				const existing = bucket.get(key);
				if (!existing || connectionRichness(entry) > connectionRichness(existing)) {
					bucket.set(key, entry);
				}
			}
		}
		return { currentConnections: Array.from(currentByKey.values()), previousConnections: Array.from(previousByKey.values()) };
	}

	function applyFirmConnectionsToState(firmId: string, currentConnections?: any[] | null, previousConnections?: any[] | null) {
		setMainJson((prev) => {
			if (!prev) return prev;
			const prevCrd = String(prev?.basicInformation?.firmId || prev?.firmId || prev?.id || '').trim();
			if (prevCrd && prevCrd !== firmId) return prev;
			return {
				...prev,
				...(Array.isArray(currentConnections) ? { currentConnections } : {}),
				...(Array.isArray(previousConnections) ? { previousConnections } : {}),
			};
		});
	}

	function connectionsFromExpandPayload(firmId: string, data: any): { currentConnections: any[]; previousConnections: any[] } | null {
		if (!data || typeof data !== 'object') return null;
		const nodes = Array.isArray(data.nodes) ? data.nodes : [];
		const links = Array.isArray(data.links) ? data.links : [];
		if (!links.length) return null;

		const nodeById = new Map<string, any>(nodes.map((node: any) => [String(node?.id || ''), node]));
		const firmNodeId = `firm:${firmId}`;
		const currentConnections: any[] = [];
		const previousConnections: any[] = [];
		const seen = new Set<string>();

		for (const link of links) {
			const relationship = String(link?.relationship || '').trim();
			// dashboard-crds uses relationship: 'employment'; this app uses employed_by / previous_employed_by / controls.
			const isEmployment = relationship === 'employment' || relationship === 'employed_by' || relationship === 'previous_employed_by';
			const isAssociatedFirm = relationship === 'associated' || relationship === 'previously_associated';
			const isControl = relationship === 'controls' || relationship === 'ownership' || relationship === 'owner';
			if (!isEmployment && !isControl && !isAssociatedFirm) continue;

			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId !== firmNodeId && targetId !== firmNodeId) continue;
			const otherId = sourceId === firmNodeId ? targetId : sourceId;
			const other = nodeById.get(otherId) || {};
			const isFirmNode = other.group === 'firm' || otherId.startsWith('firm:');
			const crd = String(other?.crd || otherId.replace(/^(?:person|individual|firm)[:_]/, '')).trim();
			if (!crd || !/^\d{1,10}$/.test(crd)) continue;

			const firmNode = nodeById.get(firmNodeId) || {};
			const isFirmTerminated = /inactive|terminated|revoked|suspended|withdrawn|ceased/i.test(String(firmNode.firmStatus || firmNode.basicInformation?.firmStatus || ''));
			const isCurrent =
				isFirmTerminated ? false
				: isControl ? true
				: relationship === 'previous_employed_by' || relationship === 'previously_associated' ? false
				: link?.isCurrent !== undefined ? Boolean(link.isCurrent)
				: !String(link?.endDate || link?.registrationEndDate || '').trim();

			const dedupeKey = `${isFirmNode ? 'firm' : 'person'}:${crd}:${isCurrent}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);

			const entry =
				isFirmNode ?
					{
						firmId: crd,
						name: String(other?.label || other?.name || `Firm ${crd}`).trim(),
						relationship: isCurrent ? 'Associated firm' : 'Previously associated firm',
						startDate: link?.startDate || link?.registrationBeginDate || undefined,
						endDate: isCurrent ? undefined : link?.endDate || link?.registrationEndDate || undefined,
						isCurrent,
					}
				:	{
						individualId: crd,
						name: String(other?.label || other?.name || `Person ${crd}`).trim(),
						relationship:
							isControl ? 'Control'
							: isCurrent ? 'Current registration'
							: 'Previous registration',
						startDate: link?.startDate || link?.registrationBeginDate || undefined,
						endDate: isCurrent ? undefined : link?.endDate || link?.registrationEndDate || undefined,
						isCurrent,
					};
			(isCurrent ? currentConnections : previousConnections).push(entry);
		}

		if (!currentConnections.length && !previousConnections.length) return null;
		return { currentConnections, previousConnections };
	}

	async function loadFirmConnections(firmId: string) {
		const existingPromise = connectionsInFlightByCrdRef.current.get(firmId);
		if (existingPromise) return existingPromise;

		const cacheKey = visitConnectionsKey(firmId);
		const cached = readVisitedSync<CachedFirmConnectionsPayload>(cacheKey) || (await readVisited<CachedFirmConnectionsPayload>(cacheKey));
		if (cached?.found && (cached.currentConnections?.length || cached.previousConnections?.length)) {
			applyFirmConnectionsToState(firmId, cached.currentConnections || [], cached.previousConnections || []);
			setConnectionsLoadingFirmId(null);
		} else {
			setConnectionsLoadingFirmId(firmId);
		}

		const fetchPromise = (async () => {
			try {
				const loadBucket = async (bucket: 'current' | 'previous') => {
					// light=1 skips Redis detail enrichment; server still hydrates names from
					// search-index gzip sidecars. Client hard-caches the full roster in IDB.
					const response = await fetch(`/api/finra/firm/${encodeURIComponent(firmId)}/connections?bucket=${bucket}&light=1`, {
						method: 'GET',
						headers: { Accept: 'application/json' },
					});
					if (!response.ok) return null;
					return response.json().catch(() => null);
				};

				const currentData = await loadBucket('current');
				if (currentData?.found) {
					applyFirmConnectionsToState(firmId, currentData.currentConnections || [], undefined);
				}

				const previousData = await loadBucket('previous');
				if (previousData?.found) {
					applyFirmConnectionsToState(firmId, undefined, previousData.previousConnections || []);
				}

				const currentConnections = currentData?.found ? currentData.currentConnections || [] : cached?.currentConnections || [];
				const previousConnections = previousData?.found ? previousData.previousConnections || [] : cached?.previousConnections || [];
				if (currentData?.found || previousData?.found) {
					rememberFirmConnectionsCache(firmId, { currentConnections, previousConnections });
				}

				return previousData || currentData || cached || null;
			} catch (err) {
				console.warn('Failed to lazy load firm connections', err);
				return cached || null;
			} finally {
				connectionsInFlightByCrdRef.current.delete(firmId);
				setConnectionsLoadingFirmId((current) => (current === firmId ? null : current));
			}
		})();

		connectionsInFlightByCrdRef.current.set(firmId, fetchPromise);
		return fetchPromise;
	}

	async function ensureFirmConnectionsLoaded(firmId: string) {
		const normalizedFirmId = String(firmId || '').trim();
		if (!normalizedFirmId) return;
		await loadFirmConnections(normalizedFirmId);
	}

	async function refreshSingleCardRecord(card: QueueCard) {
		const refreshKey = `${card.entity}:${card.id}`;
		const existing = refreshInFlightByCrdRef.current.get(refreshKey);
		if (existing) {
			return existing;
		}

		const refreshPromise = (async () => {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'fetch-crds',
					queries: [card.id],
					crds: [card.id],
					maxCrds: 1,
					includePayload: true,
				}),
			});

			return response.json().catch(() => null);
		})();

		refreshInFlightByCrdRef.current.set(refreshKey, refreshPromise);
		try {
			return await refreshPromise;
		} finally {
			refreshInFlightByCrdRef.current.delete(refreshKey);
		}
	}

	async function loadQueueSourceJson(card: QueueCard, source: SearchResultSource) {
		const sourceKey = `${card.entity}:${card.id}:${source}`;
		const loadGen = ++recordLoadGenRef.current;
		const stillCurrent = () => recordLoadGenRef.current === loadGen;
		persistDashboardScroll(dashboardContentRef.current);
		dashboardCurrentScrollRecordKey = `${card.entity}:${card.id}`;
		const cacheKey = `${card.entity}:${card.id}`;
		let snapshot = dashboardRecordSnapshotCache.get(cacheKey) || readVisitedSync<DashboardRecordSnapshot>(visitSnapshotKey(card.entity, card.id));
		if (!snapshot) {
			const persistedSnapshot = await readVisited<DashboardRecordSnapshot>(visitSnapshotKey(card.entity, card.id));
			if (!stillCurrent()) return;
			if (persistedSnapshot?.payload) {
				dashboardRecordSnapshotCache.set(cacheKey, persistedSnapshot);
				snapshot = persistedSnapshot;
			}
		}
		if (!stillCurrent()) return;
		// Stale visit-cache for Form BD people often predates parent firm fields — don't reuse those.
		if (snapshot?.payload && card.entity === 'individual' && !isCompleteNonLiveOrphanPayload(snapshot.payload)) {
			dashboardRecordSnapshotCache.delete(cacheKey);
			mergedDetailCacheRef.current.delete(cacheKey);
			snapshot = undefined as unknown as DashboardRecordSnapshot;
		}
		const resolvedSnapshot = snapshot || dashboardRecordSnapshotCache.get(cacheKey);
		if (resolvedSnapshot && (card.entity !== 'individual' || isCompleteNonLiveOrphanPayload(resolvedSnapshot.payload))) {
			const snapshot = resolvedSnapshot;
			let snapshotPayload = card.entity === 'firm' ? stripFirmConnectionLists(snapshot.payload) : snapshot.payload;
			if (card.entity === 'individual' && getNonLiveOrphanBody(snapshotPayload)) {
				snapshotPayload = ensureOrphanEnvelope(snapshotPayload, card.id);
			}
			setRecordViewLoading(false);
			setResult(null);
			setMainJson(snapshotPayload);
			setCurrentRecordSource(snapshot.source);
			setCurrentRecordEntity(card.entity);
			setCurrentRecordId(card.id);
			setMainJsonLabel(snapshot.label);
			if (card.entity === 'firm') {
				void ensureFirmConnectionsLoaded(card.id);
			} else {
				setConnectionsLoadingFirmId(null);
			}
			if (snapshot.updatedAt) markRecordUpdatedAt(snapshot.updatedAt);
			try {
				if (typeof window !== 'undefined') {
					const idPart = card.id ? ` / CRD# ${card.id}` : '';
					document.title = `${snapshot.recordName}${idPart}`;
				}
			} catch {
				/* ignore */
			}
			recordHistoryEntry({
				id: card.id,
				entity: card.entity,
				source: snapshot.source,
				sources: snapshot.detectedSources,
				name: snapshot.recordName || undefined,
			});
			syncSelectionToUrl({
				entity: card.entity,
				id: card.id,
				source: snapshot.source,
				availableSources: snapshot.detectedSources.length > 0 ? snapshot.detectedSources : card.sources.map((entry) => entry.source),
			});
			return;
		}

		activeLoadSourceKeyRef.current = sourceKey;
		setActiveCardSourceKey(sourceKey);
		setRecordViewLoading(true);
		setMainJson(null);
		setResult(null);
		setJsonTree(null);
		setCodeBlock('');
		try {
			let orderedSources: SearchResultSource[] = [source, ...card.sources.map((entry) => entry.source).filter((candidate) => candidate !== source)];

			let payload: any = null;
			let resolvedSource: SearchResultSource = source;

			const mergedDetail = await fetchMergedDetail(card);
			if (!stillCurrent()) return;
			orderedSources = resolveOrderedSourcesFromDetail(mergedDetail, source, orderedSources);
			for (const candidateSource of orderedSources) {
				payload = extractPayloadFromDetail(mergedDetail, candidateSource);
				if (payload) {
					resolvedSource = candidateSource;
					payload = overlayMergedEmploymentHistory(payload, mergedDetail);
					break;
				}
			}

			if (!payload) {
				const mergedFound = mergedDetail?.found === true;
				const mergedHasAnySource = Boolean(mergedDetail?.sources?.finra || mergedDetail?.sources?.sec || mergedDetail?.finraNode || mergedDetail?.merged);
				if (mergedFound || mergedHasAnySource) {
					const fallbackDetail = await fetchFallbackDetail(card);
					if (!stillCurrent()) return;
					mergedDetailCacheRef.current.set(cacheKey, fallbackDetail);
					orderedSources = resolveOrderedSourcesFromDetail(fallbackDetail, source, orderedSources);
					for (const candidateSource of orderedSources) {
						payload = extractPayloadFromDetail(fallbackDetail, candidateSource);
						if (payload) {
							resolvedSource = candidateSource;
							payload = overlayMergedEmploymentHistory(payload, fallbackDetail);
							break;
						}
					}
				}

				if (!payload) {
					const refreshPayload = await refreshSingleCardRecord(card);
					if (!stillCurrent()) return;
					const refreshedItems = Array.isArray(refreshPayload?.results) ? refreshPayload.results : [];
					if (refreshedItems.length > 0) {
						mergedDetailCacheRef.current.delete(cacheKey);
						dashboardRecordSnapshotCache.delete(cacheKey);
						const refreshedDetail = await fetchMergedDetail(card);
						orderedSources = resolveOrderedSourcesFromDetail(refreshedDetail, source, orderedSources);
						for (const candidateSource of orderedSources) {
							payload = extractPayloadFromDetail(refreshedDetail, candidateSource);
							if (payload) {
								resolvedSource = candidateSource;
								payload = overlayMergedEmploymentHistory(payload, refreshedDetail);
								break;
							}
						}
					}
				}
			}

			if (!payload && card.entity === 'individual' && card.orphanHints?.parentCrd) {
				payload = buildOrphanIndividualPayloadFromHints(card.id, card.orphanHints);
			}

			if (!payload) {
				setMainJson(null);
				setMainJsonLabel(`${source}:${card.entity}:${card.id}`);
				setCurrentRecordSource(source);
				setCurrentRecordEntity(card.entity);
				setCurrentRecordId(card.id);
				setResult({
					ok: false,
					error: `No ${String(source).toUpperCase()} payload found for ${card.entity} ${card.id} after merged/fallback lookup and auto-refresh retry.`,
				});
				return;
			}

			if (payload && typeof payload === 'object') {
				const payloadHasFinra = payload?.hasFinraData === true;
				const payloadHasSec = payload?.hasSecData === true;
				if (!payloadHasFinra && payloadHasSec) {
					resolvedSource = 'sec';
				} else if (payloadHasFinra && !payloadHasSec) {
					resolvedSource = 'finra';
				}
			}

			const detectedSourcesSet = new Set<SearchResultSource>();
			if (
				mergedDetail?.hasFinraData === true ||
				payload?.hasFinraData === true ||
				(card.entity === 'individual' ? hasIndividualSourceCoverage(payload, 'finra') : hasFirmSourceCoverage(payload, 'finra'))
			) {
				detectedSourcesSet.add('finra');
			}
			if (
				mergedDetail?.hasSecData === true ||
				payload?.hasSecData === true ||
				(card.entity === 'individual' ? hasIndividualSourceCoverage(payload, 'sec') : hasFirmSourceCoverage(payload, 'sec'))
			) {
				detectedSourcesSet.add('sec');
			}
			const isOrphanPayload = Boolean(payload?.orphan && typeof payload.orphan === 'object');
			// Fall back to the resolved source only when neither coverage check found a real association,
			// and this is not an orphan record, so at least one tag is shown instead of leaving normal cards blank.
			if (!isOrphanPayload && detectedSourcesSet.size === 0 && resolvedSource) detectedSourcesSet.add(resolvedSource);
			const detectedSources = Array.from(detectedSourcesSet);

			if (!stillCurrent()) return;
			let normalizedPayload = normalizePayloadForCleanView(payload) as Record<string, any>;
			if (card.entity === 'individual' && (isOrphanPayload || getNonLiveOrphanBody(normalizedPayload))) {
				normalizedPayload = ensureOrphanEnvelope(normalizedPayload, card.id);
			}
			setMainJson(normalizedPayload);
			setCurrentRecordSource(resolvedSource);
			setCurrentRecordEntity(card.entity);
			setCurrentRecordId(card.id);

			if (card.entity === 'firm') {
				void ensureFirmConnectionsLoaded(card.id);
			} else {
				setConnectionsLoadingFirmId(null);
			}

			const detailName = extractEntityDetailFromPayload(payload, card.entity, card.id)?.name;
			const computedDisplayName = getRecordDisplayName(payload as Record<string, unknown>, card.entity, card.id);
			const resolvedRecordName =
				toText(card.name) ||
				(toText(detailName) && !looksLikeGenericEntityLabel(detailName) ? toText(detailName) : '') ||
				(toText(computedDisplayName) && !looksLikeGenericEntityLabel(computedDisplayName) ? toText(computedDisplayName) : '') ||
				resolveEntityNodeLabel(payload as Record<string, any>, card.entity, card.id);
			setMainJsonLabel(
				resolveMainRecordTitle({
					mainJsonLabel: formatMainPanelTitle({
						source: resolvedSource,
						entity: card.entity,
						id: card.id,
						name: resolvedRecordName,
						payload,
					}),
					fallbackName: resolvedRecordName || null,
					entity: card.entity,
					id: card.id,
				}),
			);

			// update document title for dashboard view
			try {
				if (typeof window !== 'undefined') {
					const nameForTitle = resolveMainRecordTitle({
						mainJsonLabel: resolvedRecordName,
						fallbackName: resolvedRecordName || null,
						entity: card.entity,
						id: card.id,
					});
					const idPart = card.id ? ` / CRD# ${card.id}` : '';
					document.title = `${nameForTitle}${idPart}`;
				}
			} catch (e) {
				/* ignore */
			}
			const updatedAt = new Date().toISOString();
			markRecordUpdatedAt(updatedAt);
			rememberDashboardRecordSnapshot(cacheKey, {
				payload: normalizedPayload,
				source: resolvedSource,
				label: resolveMainRecordTitle({
					mainJsonLabel: formatMainPanelTitle({
						source: resolvedSource,
						entity: card.entity,
						id: card.id,
						name: resolvedRecordName,
						payload,
					}),
					fallbackName: resolvedRecordName || null,
					entity: card.entity,
					id: card.id,
				}),
				detectedSources,
				recordName: resolvedRecordName,
				updatedAt,
			});
			recordHistoryEntry({
				id: card.id,
				entity: card.entity,
				source: resolvedSource,
				sources: detectedSources,
				name: resolvedRecordName || undefined,
			});
			syncSelectionToUrl({
				entity: card.entity,
				id: card.id,
				source: resolvedSource,
				availableSources: detectedSources.length > 0 ? detectedSources : card.sources.map((entry) => entry.source),
			});
		} catch (error: any) {
			if (!stillCurrent()) return;
			setResult({ ok: false, error: error?.message || String(error) });
		} finally {
			if (!stillCurrent()) return;
			setRecordViewLoading(false);
			setActiveCardSourceKey((current) => (current === sourceKey ? null : current));
			if (activeLoadSourceKeyRef.current === sourceKey) {
				activeLoadSourceKeyRef.current = null;
			}
		}
	}

	async function runAction(action: DashboardAction, overrideQueries?: string[]) {
		setBusyAction(action);
		setResult(null);
		setRecordUpdatedAt(null);
		const startedAt = Date.now();
		const pendingQueries =
			action === 'fetch-crds' ?
				overrideQueries && overrideQueries.length > 0 ?
					overrideQueries
				:	queueQueries
			:	[];
		setSubmittedQueueQueries(pendingQueries);
		setQueueRunItems(buildQueueRunItems(pendingQueries));
		const effectiveQueries = pendingQueries;

		if (action === 'fetch-crds') {
			setSessionHasFetched(true);
			setQueueElapsedSec(0);
			setTerminalLogs([]);

			type LocalQueueItem = { query: string; depth: number };
			const initialQueue: LocalQueueItem[] = effectiveQueries.map((q) => ({
				query: q,
				depth: 0,
			}));
			const processed = new Set<string>();

			setCrawlProgress({
				active: true,
				current: 0,
				total: initialQueue.length,
				query: '',
				ok: 0,
				new: 0,
				updated: 0,
				err: 0,
			});

			let totalSuccess = 0;
			let totalError = 0;
			let totalNew = 0;
			let totalUpdated = 0;
			let itemsProcessed = 0;

			const queue = [...initialQueue];

			while (queue.length > 0) {
				const item = queue.shift()!;
				const { query, depth } = item;

				if (processed.has(query)) continue;
				processed.add(query);

				itemsProcessed++;
				setCrawlProgress((p) =>
					p ?
						{
							...p,
							current: itemsProcessed,
							total: itemsProcessed + queue.length,
							query,
						}
					:	null,
				);

				setQueueRunItems((prev) => prev.map((entry) => (entry.query === query ? { ...entry, status: 'running', elapsedSec: 0 } : entry)));
				setTerminalLogs((prev) => [
					...prev,
					{
						id: createQueueTerminalLogId('start', itemsProcessed, depth),
						text: `>[${itemsProcessed}/${itemsProcessed + queue.length}] Depth ${depth} | Query: "${query}"`,
						type: 'info',
					},
				]);

				try {
					const response = await fetch('/api/dashboard/refresh', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							action: 'fetch-crds',
							queries: [query],
							maxCrds: 1,
							includePayload: true,
						}),
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

					setQueueRunItems((prev) =>
						prev.map((entry) =>
							entry.query === query ?
								{
									...entry,
									status: 'complete',
									elapsedSec: 0,
									message: 'Success',
								}
							:	entry,
						),
					);

					const summary = payload.summary || {};
					const results = payload.results || [];
					let qNew = 0,
						qUpd = 0,
						qErr = 0;
					let qNewPeople = 0,
						qNewFirms = 0;

					const newLogs: {
						id: string;
						text: string;
						type: 'info' | 'error' | 'warn' | 'success';
					}[] = [];

					// Collect best name per CRD across sources
					const nameMap = new Map<string, string>();
					for (const r of results) {
						if (r?.name) {
							const key = `${r.type}:${r.crd}`;
							if (!nameMap.has(key)) nameMap.set(key, String(r.name).trim());
						}
					}

					for (const [resultIndex, r] of results.entries()) {
						let type: 'info' | 'error' | 'warn' | 'success' = 'info';
						const domain = r.source === 'finra' ? 'FINRA' : 'SEC';
						const nameLabel = nameMap.get(`${r.type}:${r.crd}`);
						const label = nameLabel ? `${r.crd} "${nameLabel}"` : r.crd;

						let msg = `  - ${domain} ${r.type} ${label}: `;

						if (r.status === 'error') {
							qErr++;
							type = 'error';
							msg += `Error (${r.error})`;
						} else if (r.status === 'skipped') {
							type = 'warn';
							msg += `Skipped (${r.skipReason})`;
						} else {
							if (r.newRecordSaved) {
								qNew++;
								if (String(r.type).toLowerCase() === 'firm') qNewFirms++;
								else qNewPeople++;
								msg += `Saved (New Record)`;
								type = 'success';
							} else if (r.newSourceSaved) {
								qUpd++;
								msg += `Saved (Updated Source)`;
								type = 'success';
							} else {
								msg += `Unchanged`;
								type = 'info';
							}
						}
						newLogs.push({
							id: createQueueTerminalLogId(`result-${String(r.source)}-${String(r.crd)}`, itemsProcessed, resultIndex + 1),
							text: msg,
							type,
						});
					}

					setTerminalLogs((prev) => [...prev, ...newLogs]);
					addCardsToLocalHistory(results);

					totalNew += qNew;
					totalUpdated += qUpd;
					totalSuccess += summary.successCount || 0;
					totalError += qErr;

					setCrawlProgress((p) =>
						p ?
							{
								...p,
								ok: totalSuccess,
								new: totalNew,
								updated: totalUpdated,
								err: totalError,
							}
						:	null,
					);

					// Recursion logic (Up to 3 levels deep)
					if (depth < 3) {
						const discovered = payload.discovered || [];
						const resolution = payload.resolution || [];

						const uniqueDiscovered = new Set<string>();

						for (const res of resolution) {
							if (Array.isArray(res.crds)) {
								for (const c of res.crds) uniqueDiscovered.add(c);
							}
						}
						for (const dCrd of discovered) {
							uniqueDiscovered.add(dCrd);
						}

						for (const dCrd of uniqueDiscovered) {
							if (!processed.has(dCrd) && !queue.some((qi) => qi.query === dCrd)) {
								// Global safety break to prevent runaway crawls
								if (processed.size < 500) {
									queue.push({ query: dCrd, depth: depth + 1 });
								}
							}
						}
					}

					if (qNew > 0) {
						setQueueMetaStats((current) => {
							const t = current.inventoryTotals ?? {
								people: 0,
								firms: 0,
								unique: 0,
								source: 'redis' as const,
							};
							return {
								...current,
								inventoryTotals: {
									...t,
									unique: Number(t.unique || 0) + qNew,
									people: Number(t.people || 0) + qNewPeople,
									firms: Number(t.firms || 0) + qNewFirms,
								},
							};
						});
					}

					setTerminalLogs((prev) => [
						...prev,
						{
							id: createQueueTerminalLogId('done', itemsProcessed, depth),
							text: `  -> Query complete: ${qNew} new, ${qUpd} updated, ${qErr} errors`,
							type: qErr > 0 ? 'warn' : 'info',
						},
					]);
				} catch (err: any) {
					totalError++;
					setCrawlProgress((p) => (p ? { ...p, err: totalError } : null));
					const errText = String(err.message || err);
					if (errText.includes('no-valid-crds') || errText.includes('No valid CRDs')) {
						setTerminalLogs((prev) => [
							...prev,
							{
								id: createQueueTerminalLogId('error', itemsProcessed, depth),
								text: `  -> no valid CRDs`,
								type: 'warn',
							},
						]);
					} else {
						setTerminalLogs((prev) => [
							...prev,
							{
								id: createQueueTerminalLogId('error', itemsProcessed, depth),
								text: `  -> Request Failed: ${errText}`,
								type: 'error',
							},
						]);
					}
				}
			}

			setCrawlProgress((p) => (p ? { ...p, active: false } : null));
			void loadQueueCardsFromRedis(queueCrdFilter);
			setBusyAction(null);
			setTerminalLogs((prev) => [
				...prev,
				{
					id: createQueueTerminalLogId('finish', initialQueue.length, 0),
					text: `\nFinished. Total OK: ${totalSuccess}, New: ${totalNew}, Err: ${totalError}`,
					type: 'success',
				},
			]);
			void loadNewCrdsFromRedis(true);
			return;
		}

		try {
			const body =
				action === 'list-new-crds' ?
					{
						action,
					}
				:	{
						action,
						externalRawDir,
					};

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort('dashboard-request-timeout'), 15 * 60 * 1000);

			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			const contentType = response.headers.get('content-type');
			const rawText = await response.text();
			let payload: ApiResponse | null = null;
			if (contentType?.includes('application/json')) {
				payload = JSON.parse(rawText) as ApiResponse;
			}

			if (!response.ok || !payload) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: rawText,
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}

			if (payload.ok === false) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: String(payload.error || rawText || ''),
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}
			setResult(payload);
			markRecordUpdatedAt((payload as any)?.at);

			if (action === 'list-new-crds') {
				const newCrdsData = (payload as any)?.newCrds || [];
				setNewCrds(newCrdsData);
			}
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
			markRecordUpdatedAt();
		} finally {
			setBusyAction(null);
		}
	}

	async function runRedisSearch() {
		const query = searchQuery.trim();
		if (!query) {
			setSearchResults([]);
			setSearchError(null);
			setSearchSkippedCount(0);
			setHasSearchRun(false);
			return;
		}

		setHasSearchRun(true);
		setSearchBusy(true);
		setSearchError(null);
		setSearchResults([]);
		setSearchSkippedCount(0);

		try {
			const includePeople = searchType === 'all' || searchType === 'people';
			const includeFirms = searchType === 'all' || searchType === 'firms';
			const [finraIndividualRes, finraFirmRes, secIndividualRes, secFirmRes] = await Promise.all([
				includePeople ? fetch(`/api/finra/search?type=individual&query=${encodeURIComponent(query)}&rows=24`) : Promise.resolve(null),
				includeFirms ? fetch(`/api/finra/search?type=firm&query=${encodeURIComponent(query)}&rows=24`) : Promise.resolve(null),
				includePeople ? fetch(`/api/finra/sec-search?query=${encodeURIComponent(query)}&rows=24`) : Promise.resolve(null),
				includeFirms ? fetch(`/api/finra/sec-search-firm?query=${encodeURIComponent(query)}&rows=24`) : Promise.resolve(null),
			]);

			const [finraIndividualJson, finraFirmJson, secIndividualJson, secFirmJson] = await Promise.all([
				finraIndividualRes ? finraIndividualRes.json() : Promise.resolve(null),
				finraFirmRes ? finraFirmRes.json() : Promise.resolve(null),
				secIndividualRes ? secIndividualRes.json() : Promise.resolve(null),
				secFirmRes ? secFirmRes.json() : Promise.resolve(null),
			]);

			const getItems = (payload: any) =>
				Array.isArray(payload?.results) ? payload.results
				: Array.isArray(payload?.currentPage) ? payload.currentPage
				: Array.isArray(payload?.hits?.hits) ? payload.hits.hits.map((hit: any) => hit?._source ?? hit)
				: [];

			const normalize = (items: SearchResult[], source: SearchResultSource, entity: 'individual' | 'firm') => {
				let skipped = 0;
				const cards: SearchResultCard[] = [];

				for (const item of items) {
					if (isCorruptSearchItem(item)) {
						skipped += 1;
						continue;
					}

					const id = extractValidCrd(item, entity);
					if (!id) {
						skipped += 1;
						continue;
					}

					// Minimal FINRA search-index stub docs only carry {id, crd, label, type, source} — no
					// name/firstName/lastName fields — so fall back to the stub's own `label` field too.
					const rawLabel =
						String(item?.name || item?.fullName || item?.firmName || item?.firstName || item?.lastName || item?.title || item?.label || '').trim() ||
						`${entity === 'firm' ? 'Firm' : 'Individual'} CRD #${id}`;
					const label = entity === 'firm' ? formatFirmName(rawLabel) : formatPersonName(rawLabel);
					const scope = String(item?.bcScope || item?.iaScope || item?.status || item?.registrationStatus || '').trim();
					const address = extractSearchResultAddress(item);
					const detail = extractSearchResultDetail(item);
					const otherNames = extractSearchResultOtherNames(item);
					cards.push({
						id,
						label,
						scope,
						address,
						detail,
						otherNames,
						source,
						entity,
						payload: item,
					});
				}

				return { cards, skipped };
			};

			const finraIndividuals = includePeople ? normalize(getItems(finraIndividualJson), 'finra', 'individual') : { cards: [], skipped: 0 };
			const finraFirms = includeFirms ? normalize(getItems(finraFirmJson), 'finra', 'firm') : { cards: [], skipped: 0 };
			const secIndividuals = includePeople ? normalize(getItems(secIndividualJson), 'sec', 'individual') : { cards: [], skipped: 0 };
			const secFirms = includeFirms ? normalize(getItems(secFirmJson), 'sec', 'firm') : { cards: [], skipped: 0 };

			const skippedTotal = finraIndividuals.skipped + finraFirms.skipped + secIndividuals.skipped + secFirms.skipped;
			if (skippedTotal > 0) {
				console.warn('[dashboard] skipped search records due to missing CRD or corrupt payload', {
					query,
					skippedTotal,
				});
			}

			setSearchSkippedCount(skippedTotal);
			const rawCards = [...finraIndividuals.cards, ...finraFirms.cards, ...secIndividuals.cards, ...secFirms.cards];
			const mergedCardsMap = new Map<string, SearchResultCard>();

			for (const card of rawCards) {
				const key = `${card.entity}:${card.id}`;
				if (mergedCardsMap.has(key)) {
					const existing = mergedCardsMap.get(key)!;
					const sources = new Set(existing.availableSources || [existing.source]);
					sources.add(card.source);
					existing.availableSources = Array.from(sources);
					// If FINRA has richer detail, prefer it, otherwise keep SEC
					if (card.source === 'finra' && existing.source === 'sec') {
						existing.source = 'finra';
						existing.label = card.label;
						existing.address = card.address || existing.address;
						existing.detail = card.detail || existing.detail;
					}
				} else {
					card.availableSources = [card.source];
					mergedCardsMap.set(key, card);
				}
			}

			const combinedCards = Array.from(mergedCardsMap.values());
			setSearchResults(combinedCards);

			// Hydrate cards (real name/address/otherNames) from full detail routes in the background,
			// same approach as graph-search's direct-CRD fallback — minimal search-index stub docs
			// only carry {id, crd, label, type, source}. Cap concurrency to avoid hammering the API.
			const HYDRATE_LIMIT = 40;
			void hydrateSearchResultCardsBatch(combinedCards.slice(0, HYDRATE_LIMIT)).then((hydratedCards) => {
				setSearchResults((current) => {
					const byKey = new Map(hydratedCards.map((card) => [`${card.entity}:${card.id}:${card.source}`, card]));
					return current.map((card) => byKey.get(`${card.entity}:${card.id}:${card.source}`) || card);
				});
			});
		} catch (error: any) {
			setSearchError(error?.message || String(error));
		} finally {
			setSearchBusy(false);
		}
	}

	function renderJsonTree(node: any, depth = 0) {
		if (!node) return null;
		if (node.type === 'primitive') {
			return (
				<div
					className={styles.jsonTreeLeaf}
					style={{ marginLeft: depth * 12 }}>
					{node.key && <span className={styles.jsonTreeKey}>{node.key}</span>}
					<span className={styles.jsonTreeValue}>{node.value}</span>
				</div>
			);
		}

		return (
			<div
				className={styles.jsonTreeGroup}
				style={{ marginLeft: depth * 10 }}>
				{node.key && <div className={styles.jsonTreeGroupHeader}>{node.key}</div>}
				{node.children?.map((child: any, index: number) => (
					<div key={`${child.key || 'child'}-${index}`}>{renderJsonTree(child, depth + 1)}</div>
				))}
			</div>
		);
	}

	function highlightConnectionMatch(text: string, query: string): React.ReactNode {
		const trimmedQuery = query.trim();
		if (!trimmedQuery || !text) return text;
		const tokens = Array.from(new Set(trimmedQuery.split(/\s+/).filter(Boolean))).sort((a, b) => b.length - a.length);
		if (!tokens.length) return text;
		const pattern = new RegExp(`(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
		const parts = text.split(pattern);
		if (parts.length <= 1) return text;
		const tokenSet = new Set(tokens.map((token) => token.toLowerCase()));
		return parts.map((part, index) =>
			tokenSet.has(part.toLowerCase()) ?
				<mark
					key={index}
					className={styles.connectionMatchHighlight}>
					{part}
				</mark>
			:	<Fragment key={index}>{part}</Fragment>,
		);
	}

	function highlightSearchMatch(text: string, query: string): React.ReactNode {
		const trimmedQuery = query.trim();
		if (!trimmedQuery || !text) return text;
		const tokens = Array.from(new Set(trimmedQuery.split(/\s+/).filter((token) => token.length >= 2))).sort((a, b) => b.length - a.length);
		if (!tokens.length) return text;
		const pattern = new RegExp(`(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
		const parts = text.split(pattern);
		if (parts.length <= 1) return text;
		return parts.map((part, index) =>
			pattern.test(part) ?
				<mark
					key={index}
					className={styles.searchResultHighlight}>
					{part}
				</mark>
			:	<Fragment key={index}>{part}</Fragment>,
		);
	}

	function renderSearchResult(card: SearchResultCard, index: number) {
		const hasFinra = card.availableSources ? card.availableSources.includes('finra') : card.source === 'finra';
		const hasSec = card.availableSources ? card.availableSources.includes('sec') : card.source === 'sec';
		const sourceLabel = [hasFinra && 'FINRA', hasSec && 'SEC'].filter(Boolean).join(' / ');
		const rowAddress = card.address || card.detail || 'No address/details in cached index';
		const otherNamesText = card.otherNames && card.otherNames.length > 0 ? `aka ${card.otherNames.join(', ')}` : '';
		const isSelected = currentRecordId === card.id && currentRecordEntity === card.entity;

		return (
			<div
				key={`${card.entity}:${card.id}:${card.source}:${index}`}
				className={`${styles.searchResultCard} ${isSelected ? styles.searchResultCardSelected : ''}`}
				aria-selected={isSelected}>
				<button
					type='button'
					className={styles.searchSourceBtn}
					onClick={() => void setMainViewFromSearch(card)}>
					<div className={styles.searchResultRow}>
						<span className={styles.searchResultNameCell}>
							<span className={styles.searchResultName}>{highlightSearchMatch(card.label, searchQuery)}</span>
							{otherNamesText && <span className={styles.searchResultOtherNames}>{highlightSearchMatch(otherNamesText, searchQuery)}</span>}
						</span>
						<span className={styles.searchResultCrd}>CRD #{card.id}</span>
						<span className={styles.searchResultAddress}>{highlightSearchMatch(rowAddress, searchQuery)}</span>
						<span className={styles.searchTag}>{sourceLabel}</span>
					</div>
				</button>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<div className='fg-header-brand'>
						<a
							href='/'
							style={{ textDecoration: 'none', color: 'inherit' }}>
							<h1
								className='fg-title'
								style={{ fontSize: '14px' }}>
								FINRA/SEC
							</h1>
						</a>
					</div>
					<div
						id='fg-header-controls'
						className='fg-header-controls'>
						<div className='fg-fetch-status'>
							<div className='fg-fetch'>
								<div className='fg-fetch-field'>
									<input
										id='fg-fetch-input'
										className='fg-fetch-input'
										type='search'
										value={searchQuery}
										onChange={(event) => setSearchQuery(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === 'Enter') {
												event.preventDefault();
												void runRedisSearch();
											}
										}}
										placeholder='firm, person, CRD/SEC#'
										autoComplete='off'
										autoCorrect='off'
										autoCapitalize='off'
										spellCheck={false}
									/>
								</div>
								<button
									id='fg-database-search'
									type='button'
									className='fg-btn-primary fg-action-btn'
									title='Search all records in the local database'
									data-fetching={searchBusy ? 'true' : 'false'}
									disabled={searchBusy}
									onClick={() => void runRedisSearch()}>
									<span className='fg-search-button-content'>
										Search
										<select
											id='fg-search-type'
											className='fg-search-type-inside'
											value={searchType}
											onChange={(event) => setSearchType(event.target.value as 'all' | 'people' | 'firms')}
											onClick={(event) => event.stopPropagation()}
											onMouseDown={(event) => event.stopPropagation()}
											title='Search type: all, people, or firms'
											aria-label='Search type'>
											<option value='all'>All</option>
											<option value='people'>People</option>
											<option value='firms'>Firms</option>
										</select>
									</span>
								</button>
							</div>
						</div>
					</div>
					<div
						className='fg-header-right-controls'
						style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
						<Link
							href={graphHref}
							onClick={handleGraphBackClick}
							className='fg-ghost-btn'
							style={{ textDecoration: 'none' }}>
							Graph
						</Link>
						<button
							type='button'
							className={styles.rightPaneToggleInline}
							onClick={toggleNewCrdsOpen}
							aria-expanded={newCrdsOpen}>
							{newCrdsOpen ? 'Hide Panel' : 'new CRDs'}
						</button>
					</div>
				</div>
			</header>
			<button
				type='button'
				className={styles.rightPaneToggle}
				onClick={toggleNewCrdsOpen}
				aria-expanded={newCrdsOpen}>
				{newCrdsOpen ? 'Hide Panel' : 'new CRDs'}
			</button>
			<div className={`${styles.layout} ${!newCrdsOpen ? styles.layoutRightHidden : ''}`}>
				<section className={styles.centerPane}>
					<div className={styles.dashboardMainStack}>
						<div
							ref={dashboardContentRef}
							className={styles.dashboardContent}
							onScroll={(e) => {
								persistDashboardScroll(e.currentTarget);
							}}
							onClickCapture={(event) => {
								persistDashboardScroll(dashboardContentRef.current);
								handleInternalDashboardLinkClick(event);
							}}>
							{crawlProgress && crawlProgress.active && (
								<div className={styles.crawlBanner}>
									<div>
										<strong>Sequential Crawl:</strong> {crawlProgress.current} / {crawlProgress.total}
										<span style={{ opacity: 0.7, marginLeft: 8 }}>({crawlProgress.query})</span>
									</div>
									<div className={styles.crawlBannerStats}>
										<span>{crawlProgress.new} new</span>
										<span>{crawlProgress.updated} updated</span>
										<span>{crawlProgress.err} errors</span>
									</div>
								</div>
							)}

							{terminalLogs.length > 0 && (
								<div className={styles.terminalWindow}>
									{[...terminalLogs].reverse().map((log) => (
										<div
											key={log.id}
											className={`${styles.terminalLine} ${styles['terminalLine_' + log.type]}`}>
											{log.text}
										</div>
									))}
								</div>
							)}

							{searchPaneOpen && (
								<div className={styles.searchResultsPane}>
									<div className={styles.searchSummary}>
										{searchSummary}
										<span className={styles.searchDockMeta}>
											{' · '}
											<RedisConnectionLabel /> Redis CRDs: {uniqueCrdCounts.total.toLocaleString()}
										</span>
									</div>
									{searchResults.length > 0 ?
										<div className={styles.searchResultsList}>{searchResults.map(renderSearchResult)}</div>
									: !searchBusy ?
										<div className={styles.searchResultsEmpty}>No Redis results yet for this query.</div>
									:	null}
									<div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
										<button
											type='button'
											className={styles.searchResultsCloseBtn}
											aria-label='Close search results'
											title='Close search results'
											onClick={() => {
												setSearchResults([]);
												setSearchError(null);
												setSearchSkippedCount(0);
												setHasSearchRun(false);
											}}>
											Close Results
										</button>
									</div>
								</div>
							)}

							{hasCurrentRecord && (
								<>
									{recordViewLoading ?
										<div className={styles.searchSummary}>
											<VectorLoader
												size='lg'
												label={`Loading ${
													currentRecordEntity ?
														currentRecordEntity === 'firm' ?
															'firm'
														:	'individual'
													:	'record'
												} profile…`}
												sublabel={currentRecordId ? `CRD #${currentRecordId}` : undefined}
											/>
										</div>
									:	<>
											<div className={styles.recordHeaderRow}>
												<span className={`${styles.recordBadge} ${currentRecordEntity === 'firm' ? styles.recordBadgeFirm : styles.recordBadgeIndividual}`}>
													{currentRecordEntity ? String(currentRecordEntity).toUpperCase() : 'UNKNOWN'}
												</span>
												{currentRecordId && <span className={styles.recordBadgeCrd}>CRD {currentRecordId}</span>}
												{detailedMainRecord?.hasFinraData && <span className={styles.tagFinra}>FINRA</span>}
												{detailedMainRecord?.hasSecData && <span className={styles.tagSec}>SEC</span>}
												{orphanRecord &&
													!detailedMainRecord?.hasFinraData &&
													!detailedMainRecord?.hasSecData &&
													(() => {
														const firmStatus = String((orphanRecord as any).firmStatus || (orphanRecord as any).status || '').trim();
														const inactive = /inactive|terminated|revoked|suspended|notinscope/i.test(firmStatus.replace(/\s+/g, ''));
														const label = inactive ? 'FINRA: Inactive' : 'FINRA: Active';
														return (
															<>
																<span className={styles.tagFinra}>FINRA</span>
																<span className={inactive ? styles.recordBadgeInactive : styles.recordBadgeActive}>{label}</span>
																<span
																	className={styles.recordBadgeFormBd}
																	title='Form BD Direct Owners & Executive Officers'>
																	Form BD — Direct Owners & Executive Officers
																</span>
															</>
														);
													})()}
												{detailedMainRecord?.finraActive && (
													<span className={/(inactive|terminated|revoked|suspended|notinscope|withdrawn|barred|expelled|denied|ceased|closed|cancelled|canceled|previouslyregistered|nolongerregistered|notregistered|expanded|historical)/i.test(detailedMainRecord.finraActive.replace(/[^a-z0-9]+/gi, '')) ? styles.recordBadgeInactive : styles.recordBadgeActive}>
														{detailedMainRecord.finraActive}
													</span>
												)}
												{detailedMainRecord?.secActive && (
													<span className={/(inactive|terminated|revoked|suspended|notinscope|withdrawn|barred|expelled|denied|ceased|closed|cancelled|canceled|previouslyregistered|nolongerregistered|notregistered|expanded|historical)/i.test(detailedMainRecord.secActive.replace(/[^a-z0-9]+/gi, '')) ? styles.recordBadgeInactive : styles.recordBadgeActive}>
														{detailedMainRecord.secActive}
													</span>
												)}
												{currentRecordEntity === 'firm' &&
													detailedMainRecord?.basicInformation &&
													(() => {
														const bi = detailedMainRecord.basicInformation as Record<string, unknown>;
														const facts: Array<{
															label: string;
															value: string;
														}> = [
															{
																label: 'District',
																value: String(bi.districtName || '').trim(),
															},
															{
																label: 'Type',
																value: String(bi.firmType || '').trim(),
															},
															{
																label: 'State',
																value: String(bi.formedState || '').trim(),
															},
															{
																label: 'Size',
																value: String(bi.firmSize || '').trim(),
															},
														].filter((fact) => fact.value !== '');
														if (!facts.length) return null;
														return (
															<div className={styles.quickFactsPanel}>
																{detailedMainRecord?.hasFinraData && (
																	<span
																		className='fg-firm-summary__role-icon fg-firm-summary__role-icon--broker'
																		title='Regulated by FINRA'
																		aria-hidden='true'>
																		B
																	</span>
																)}
																{detailedMainRecord?.hasSecData && (
																	<span
																		className='fg-firm-summary__role-icon fg-firm-summary__role-icon--ia'
																		title='Investment Adviser (SEC)'
																		aria-hidden='true'>
																		IA
																	</span>
																)}
																{facts.map((fact) => (
																	<div
																		key={fact.label}
																		className={styles.quickFactsItem}>
																		<span className={styles.quickFactsLabel}>{fact.label}</span>
																		<span className={styles.quickFactsValue}>{fact.value}</span>
																	</div>
																))}
															</div>
														);
													})()}
											</div>
											<h2 className={styles.recordTitle}>
												{orphanRecord ?
													currentRecordEntity === 'firm' ?
														formatFirmName(orphanRecord.firmName || mainJsonLabel)
													:	formatPersonName(orphanRecord.name || mainJsonLabel)
												:	mainJsonLabel}
											</h2>
											{detailedMainRecord?.subtitle && <div className={styles.recordSubtitle}>{detailedMainRecord.subtitle}</div>}
										</>
									}
								</>
							)}

							{syncBannerText && <div className={styles.statusLine}>{syncBannerText}</div>}

							{hasCurrentRecord && !recordViewLoading && mainViewMode === 'json' && (
								<div className={styles.jsonPanel}>
									{jsonRenderBusy && <div className={styles.searchSummary}>Rendering JSON…</div>}
									{jsonTree ?
										<div className={styles.jsonTreeList}>{renderJsonTree(jsonTree)}</div>
									:	<pre>{codeBlock}</pre>}
								</div>
							)}

							{hasCurrentRecord && !recordViewLoading && mainViewMode === 'card' && (
								<div className={styles.readableCardPanel}>
									{orphanRecord ?
										(() => {
											const isFirmOrphan = currentRecordEntity === 'firm';
											const parentType = String(orphanRecord.parentType || (isFirmOrphan ? 'individual' : 'firm')).toLowerCase();
											const parentIsIndividual = parentType === 'individual';
											const parentCrd = pickFirstValidCrd(orphanRecord.parentCrd) || '';
											const parentDashboardHref = parentCrd
												? `/dashboard/${parentIsIndividual ? 'individual' : 'firm'}/${parentCrd}`
												: '#';
											const parentLabel = parentIsIndividual ? 'Individual' : 'Firm';
											const personName = formatPersonName(orphanRecord.name || mainJsonLabel || '');
											const personPosition = formatUiText(orphanRecord.position) || '';
											const mainAddressLine =
												formatAddress(orphanRecord.officeAddress) ||
												(Array.isArray(orphanRecord.addresses) ? formatAddress(orphanRecord.addresses[0]) : '') ||
												formatAddress(orphanRecord.address) ||
												'';
											const mailingAddressLine = formatAddress(orphanRecord.mailingAddress) || '';
											const firmInfo = parentCrd && !parentIsIndividual ? employmentFirmInfo[parentCrd] : undefined;
											const firmStatus = String(
												(orphanRecord as any).firmStatus ||
													(orphanRecord as any).status ||
													firmInfo?.bcScope ||
													firmInfo?.firmStatus ||
													'',
											).trim();
											const inactiveParent =
												firmInfo?.isActive === false ||
												/inactive|terminated|revoked|suspended|notinscope/i.test(firmStatus.replace(/\s+/g, ''));
											return (
												<>
													{(mainAddressLine || mailingAddressLine || orphanRecord.phone) && (
														<div className={styles.detailAddressCard}>
															{mainAddressLine && (
																<div className={styles.detailAddressLine}>
																	<strong style={{ color: 'var(--text-secondary)' }}>Main Address:</strong> {mainAddressLine}
																</div>
															)}
															{mailingAddressLine && mailingAddressLine !== mainAddressLine && (
																<div className={styles.detailAddressLine}>
																	<strong style={{ color: 'var(--text-secondary)' }}>Mailing:</strong> {mailingAddressLine}
																</div>
															)}
															{mailingAddressLine && mailingAddressLine === mainAddressLine && (
																<div className={styles.detailAddressLine}>
																	<strong style={{ color: 'var(--text-secondary)' }}>Mailing:</strong> {mailingAddressLine}
																</div>
															)}
															{orphanRecord.phone && (
																<div className={styles.detailAddressLine}>
																	<strong style={{ color: 'var(--text-secondary)' }}>Phone:</strong> {orphanRecord.phone}
																</div>
															)}
														</div>
													)}

													{parentCrd && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Profile Links</h4>
															<OrphanProfileLinks
																parentCrd={parentCrd}
																parentType={parentIsIndividual ? 'individual' : 'firm'}
															/>
														</section>
													)}

													<section className={styles.detailSection}>
														<h4 className={styles.detailSectionTitle}>General Information</h4>
														<div className={styles.detailList}>
															{!isFirmOrphan && personName && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Name:</strong> {personName}
																	</div>
																</div>
															)}
															<div className={styles.detailRow}>
																<div className={styles.detailTextRow}>
																	<strong>{isFirmOrphan ? 'Firm' : 'Individual'} CRD:</strong> {currentRecordId}
																</div>
															</div>
															{personPosition && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Position:</strong> {personPosition}
																	</div>
																</div>
															)}
															{!isFirmOrphan && orphanRecord.firmName && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Affiliated Firm:</strong> {formatFirmName(orphanRecord.firmName)}
																	</div>
																</div>
															)}
															{isFirmOrphan && orphanRecord.name && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Scraped From:</strong> {formatPersonName(orphanRecord.name)}
																	</div>
																</div>
															)}
															{parentCrd && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Parent {parentLabel} CRD:</strong>{' '}
																		<Link
																			href={parentDashboardHref}
																			className={styles.detailInlineTag}>
																			{parentLabel} #{parentCrd}
																		</Link>
																	</div>
																</div>
															)}
														</div>
													</section>

													{!isFirmOrphan && parentCrd && !parentIsIndividual && (() => {
															const statusLabel = inactiveParent ? 'Inactive' : 'Active';
															const rowStatusClass = inactiveParent
																? styles.currentConnectionStatusTagInactive
																: styles.currentConnectionStatusTag;
															const rowName =
																formatFirmName(firmInfo?.firmName || orphanRecord.firmName) ||
																formatFirmName(orphanRecord.firmName) ||
																`Firm ${parentCrd}`;
															const currentFirmName = firmInfo?.firmName ? String(firmInfo.firmName).trim() : '';
															const normRowName = String(rowName || '')
																.toLowerCase()
																.replace(/[^a-z0-9]/g, '');
															const normCurrentFirmName = currentFirmName.toLowerCase().replace(/[^a-z0-9]/g, '');
															const isRenamed = Boolean(normCurrentFirmName && normRowName && normCurrentFirmName !== normRowName);
															let displayOtherNames = [...(firmInfo?.otherNames || [])];
															if (isRenamed && currentFirmName) {
																const alreadyInList = displayOtherNames.some(
																	(n) =>
																		String(n)
																			.toLowerCase()
																			.replace(/[^a-z0-9]/g, '') === normCurrentFirmName,
																);
																if (!alreadyInList) displayOtherNames.unshift(currentFirmName);
															}
															const addressLine =
																mainAddressLine ||
																formatAddress(firmInfo?.officeAddress) ||
																formatAddress(firmInfo?.address) ||
																'';
															const metaLine = [
																addressLine,
																inactiveParent ? 'Inactive' : personPosition || 'Currently Employed',
															]
																.filter(Boolean)
																.join(' • ');
															const sectionTitle = inactiveParent ? 'Previous Employment (1)' : 'Current Employment (1)';
															const rowClass = inactiveParent ? styles.previousEmploymentRow : styles.currentEmploymentRow;
															const sourceTags: string[] = [];
															if (firmInfo?.hasFinraData !== false) sourceTags.push('FINRA');
															if (firmInfo?.hasSecData) sourceTags.push('SEC');
															if (!sourceTags.length) sourceTags.push('FINRA');

															return (
																<section className={styles.detailSection}>
																	<h4 className={styles.detailSectionTitle}>{sectionTitle}</h4>
																	<div className={styles.detailList}>
																		<Link
																			href={parentDashboardHref}
																			className={`${styles.detailRow} ${styles.detailRowInteractive} ${rowClass}`}>
																			<div className={styles.detailRowMain}>
																				<div className={styles.employmentRowNameWrap}>
																					<span className={styles.detailRowName}>{rowName}</span>
																					<span className={styles.detailInlineTag}>CRD#{parentCrd}</span>
																					{sourceTags.includes('FINRA') && <span className={styles.tagFinra}>FINRA</span>}
																					{sourceTags.includes('SEC') && <span className={styles.tagSec}>SEC</span>}
																					<span className={`${styles.detailInlineTag} ${rowStatusClass}`}>{statusLabel}</span>
																				</div>
																			</div>
																			{displayOtherNames.length > 0 && (
																				<span className={styles.employmentRowOtherNames}>
																					aka{' '}
																					{displayOtherNames.map((n, nIdx) => {
																						const formatted = formatOtherName(n, true);
																						const normFormatted = String(formatted)
																							.toLowerCase()
																							.replace(/[^a-z0-9]/g, '');
																						const normRaw = String(n)
																							.toLowerCase()
																							.replace(/[^a-z0-9]/g, '');
																						const isHighlighted =
																							isRenamed && (normFormatted === normCurrentFirmName || normRaw === normCurrentFirmName);
																						return (
																							<Fragment key={`orphan-emp-other-${nIdx}`}>
																								{nIdx > 0 && ', '}
																								<span className={isHighlighted ? styles.employmentOtherNameHighlighted : undefined}>{formatted}</span>
																							</Fragment>
																						);
																					})}
																				</span>
																			)}
																			{metaLine && <div className={styles.detailRowMeta}>{metaLine}</div>}
																		</Link>
																	</div>
																</section>
															);
														})()}

													{isFirmOrphan && orphanRecord.name && parentCrd && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Scraped From (1)</h4>
															<div className={styles.detailList}>
																<Link
																	href={parentDashboardHref}
																	className={`${styles.detailRow} ${styles.detailRowInteractive}`}>
																	<div className={styles.detailRowMain}>
																		<div className={styles.employmentRowNameWrap}>
																			<span className={styles.detailRowName}>{parentIsIndividual ? formatPersonName(orphanRecord.name) : formatFirmName(orphanRecord.name)}</span>
																		</div>
																		<span className={styles.currentConnectionStatusTag}>Source {parentIsIndividual ? 'Individual' : 'Firm'}</span>
																	</div>
																	<div className={styles.detailRowMeta}>
																		{[personPosition, `CRD#${parentCrd}`].filter(Boolean).join(' • ')}
																	</div>
																	<div className={styles.detailRowSourceTags}>
																		<span className={styles.currentConnectionSourceTag}>Parent Record</span>
																	</div>
																</Link>
															</div>
														</section>
													)}

													<div className={styles.orphanNoticeAlert}>
														{isFirmOrphan ?
															<>
																No independent BrokerCheck/SEC record exists for Firm CRD {currentRecordId}. This firm was scraped from{' '}
																{parentCrd ?
																	<Link
																		href={parentDashboardHref}
																		className={styles.detailInlineTag}>
																		Individual CRD#{parentCrd}
																	</Link>
																:	'an individual'}
																's employment history
																{personPosition ? ` as "${personPosition}"` : ''}, and has no live CRD of its own.
															</>
														:	<>
																No independent BrokerCheck/SEC record exists for CRD {currentRecordId}. This person was scraped from{' '}
																{parentCrd ?
																	<Link
																		href={parentDashboardHref}
																		className={styles.detailInlineTag}>
																		Firm CRD#{parentCrd}
																	</Link>
																:	'a firm'}
																's own detail record
																{personPosition ? ` as "${personPosition}"` : ''}, and has no live CRD of its own.
															</>
														}
													</div>
												</>
											);
										})()
									: detailedMainRecord ?
										<>
											{detailedMainRecord.otherNames.length > 0 && (
												<div className={styles.detailOtherNamesBlock}>
													<div className={styles.detailOtherNamesHeading}>OTHER NAMES</div>
													<div
														className={styles.headerOtherNamesRow}
														style={{ margin: 0 }}>
														{detailedMainRecord.otherNames.map((name) => {
															const formatted = formatOtherName(name, currentRecordEntity === 'firm');
															return (
																<span
																	key={name}
																	className={styles.headerOtherNameTag}>
																	{formatted}
																</span>
															);
														})}
													</div>
												</div>
											)}
											{(detailedMainRecord.mainAddress || detailedMainRecord.otherNames.length > 0) && (
												<div className={styles.detailAddressCard}>
													{detailedMainRecord.mainAddress && (
														<div className={styles.detailAddressLine}>
															<strong style={{ color: 'var(--text-secondary)' }}>Main Address:</strong> {detailedMainRecord.mainAddress}
														</div>
													)}
												</div>
											)}

											<section className={styles.detailSection}>
												<h4 className={styles.detailSectionTitle}>Profile Links</h4>
												<div className={styles.detailLinkRow}>
													{detailedMainRecord.profileLinks.map((link) => (
														<a
															key={link.href}
															href={link.href}
															target='_blank'
															rel='noopener noreferrer'
															className={`${styles.detailLinkBtn} ${link.source === 'finra' ? styles.detailLinkBtnFinra : styles.detailLinkBtnSec}`}>
															{link.label}
														</a>
													))}
													{detailedMainRecord.documentLinkCards.map((link) => (
														<a
															key={link.href}
															href={link.href}
															target='_blank'
															rel='noopener noreferrer'
															className={`${styles.detailLinkBtn} ${styles.detailLinkBtnSec}`}>
															{link.title} ↗
														</a>
													))}
												</div>
											</section>

											{detailedMainRecord.crs && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Form CRS</h4>
													<div className={styles.detailGrid}>
														<div className={styles.detailGridCard}>
															<div className={styles.detailRowMain}>
																<span className={styles.detailRowName}>CRS Document ({detailedMainRecord.crs.crsType || 'PDF'})</span>
																{detailedMainRecord.crs.fileId && (
																	<a
																		href={`https://files.brokercheck.finra.org/crs_${detailedMainRecord.crs.fileId}.pdf`}
																		target='_blank'
																		rel='noopener noreferrer'
																		className={styles.detailInlineTag}>
																		View PDF ↗
																	</a>
																)}
															</div>
															{detailedMainRecord.crs.fileId && <div className={styles.detailRowMeta}>ID: {detailedMainRecord.crs.fileId}</div>}
														</div>
													</div>
												</section>
											)}

											{((detailedMainRecord.affiliateDisclosures && Object.keys(detailedMainRecord.affiliateDisclosures).length > 0) ||
												(detailedMainRecord.registrations && Object.keys(detailedMainRecord.registrations).length > 0)) && (
												<section className={styles.detailSection}>
													<button
														type='button'
														className={styles.detailToggleBar}
														onClick={() => setDetailCollectionsOpen((open) => !open)}
														aria-expanded={detailCollectionsOpen}>
														<h4 className={styles.detailSectionTitle}>Disclosures & Registrations</h4>
														<div className={styles.detailToggleStats}>
															{detailedMainRecord.affiliateDisclosures && Object.keys(detailedMainRecord.affiliateDisclosures).length > 0 && (
																<span className={styles.detailToggleStat}>Affiliate: {Object.keys(detailedMainRecord.affiliateDisclosures).length}</span>
															)}
															{detailedMainRecord.registrations && Object.keys(detailedMainRecord.registrations).length > 0 && (
																<span className={styles.detailToggleStat}>Registrations: {Object.keys(detailedMainRecord.registrations).length}</span>
															)}
															{detailedMainRecord.registrations?.stateList?.length > 0 && (
																<span className={styles.detailToggleStat}>States: {detailedMainRecord.registrations.stateList.length}</span>
															)}
														</div>
														<span
															className={styles.detailToggleChevron}
															aria-hidden='true'>
															{detailCollectionsOpen ? '−' : '+'}
														</span>
													</button>
													{detailCollectionsOpen && (
														<>
															{detailedMainRecord.affiliateDisclosures && Object.keys(detailedMainRecord.affiliateDisclosures).length > 0 && (
																<div
																	className={styles.detailSection}
																	style={{ border: '0', padding: '0', background: 'transparent' }}>
																	<h4 className={styles.detailSectionTitle}>Affiliate Disclosures</h4>
																	<div className={styles.detailGrid}>
																		{Object.entries(detailedMainRecord.affiliateDisclosures).map(([key, val]) => (
																			<div
																				key={key}
																				className={styles.detailGridCard}>
																				<div className={styles.detailRowMain}>
																					<span className={styles.detailRowName}>{humanizeKey(key)}</span>
																					<span className={styles.detailInlineTag}>{String(val)}</span>
																				</div>
																			</div>
																		))}
																	</div>
																</div>
															)}
															{detailedMainRecord.registrations && Object.keys(detailedMainRecord.registrations).length > 0 && (
																<div
																	className={styles.detailSection}
																	style={{ border: '0', padding: '0', background: 'transparent' }}>
																	<h4 className={styles.detailSectionTitle}>Registrations</h4>
																	<div className={styles.detailGrid}>
																		{Object.entries(detailedMainRecord.registrations).map(([k, v]) => {
																			if (k === 'stateList' || !v) return null;
																			return (
																				<div
																					key={`reg-${k}`}
																					className={styles.detailGridCard}>
																					<div className={styles.detailRowMain}>
																						<span className={styles.detailRowName}>{k.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => (str as string).toUpperCase())}</span>
																						<span className={styles.detailInlineTag}>{String(v)}</span>
																					</div>
																				</div>
																			);
																		})}
																	</div>
																	{detailedMainRecord.registrations.stateList?.length > 0 && (
																		<div className={styles.registeredStatesWrap}>
																			<h5 className={styles.registeredStatesTitle}>Registered States ({detailedMainRecord.registrations.stateList.length})</h5>
																			<div className={styles.registeredStatesList}>
																				{detailedMainRecord.registrations.stateList.map((st: any, idx: number) => (
																					<span
																						key={`state-${idx}`}
																						className={styles.registeredStateTag}>
																						{st.state || st.id || st.name || st}
																					</span>
																				))}
																			</div>
																		</div>
																	)}
																</div>
															)}
														</>
													)}
												</section>
											)}

											{detailedMainRecord.currentEmployment.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Current Employment ({detailedMainRecord.currentEmployment.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.currentEmployment.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
															const firmInfo = crd ? employmentFirmInfo[String(crd)] : undefined;
															const address = formatAddress(row.branchOfficeLocations?.[0]) || (row.city && row.state ? `${row.city}, ${row.state}` : '');
															const startDate = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
															const dateStr = startDate ? `Since ${startDate}` : '';
															const metaParts = [address, dateStr].filter(Boolean);
															const metaLine = metaParts.length > 0 ? metaParts.join(' • ') : formatUiText(pickFirstNonEmpty(row.position, row.currentRegistration, row.status));
															const rowName = resolveEntityNodeLabel(row, 'firm', crd, idx);
															const currentFirmName = firmInfo?.firmName ? String(firmInfo.firmName).trim() : '';
															const normRowName = String(rowName || row.firmName || '')
																.toLowerCase()
																.replace(/[^a-z0-9]/g, '');
															const normCurrentFirmName = currentFirmName.toLowerCase().replace(/[^a-z0-9]/g, '');
															const isRenamed = Boolean(normCurrentFirmName && normRowName && normCurrentFirmName !== normRowName);

															let displayOtherNames = [...(firmInfo?.otherNames || [])];
															if (isRenamed && currentFirmName) {
																const alreadyInList = displayOtherNames.some(
																	(n) =>
																		String(n)
																			.toLowerCase()
																			.replace(/[^a-z0-9]/g, '') === normCurrentFirmName,
																);
																if (!alreadyInList) {
																	displayOtherNames.unshift(currentFirmName);
																}
															}

															const statusKey = resolveEmploymentStatusTag(row, firmInfo);
															const rowStatusClass = /inactive/i.test(String(statusKey)) ? styles.currentConnectionStatusTagInactive : styles.currentConnectionStatusTag;
															const sourceTags = Array.from(new Set([...(Array.isArray(row.sourceTags) ? row.sourceTags : []), row.sourceTag].filter(Boolean)));

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<div className={styles.employmentRowNameWrap}>
																			<span className={styles.detailRowName}>{rowName}</span>
																			{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																			{sourceTags.includes('FINRA') && <span className={styles.tagFinra}>FINRA</span>}
																			{sourceTags.includes('SEC') && <span className={styles.tagSec}>SEC</span>}
																			{statusKey && <span className={`${styles.detailInlineTag} ${rowStatusClass}`}>{String(statusKey)}</span>}
																		</div>
																	</div>
																	{displayOtherNames.length > 0 && (
																		<span className={styles.employmentRowOtherNames}>
																			aka{' '}
																			{displayOtherNames.map((n, nIdx) => {
																				const formatted = formatOtherName(n, true);
																				const normFormatted = String(formatted)
																					.toLowerCase()
																					.replace(/[^a-z0-9]/g, '');
																				const normRaw = String(n)
																					.toLowerCase()
																					.replace(/[^a-z0-9]/g, '');
																				const isHighlighted = isRenamed && (normFormatted === normCurrentFirmName || normRaw === normCurrentFirmName);
																				return (
																					<Fragment key={`cur-emp-other-${idx}-${nIdx}`}>
																						{nIdx > 0 && ', '}
																						<span className={isHighlighted ? styles.employmentOtherNameHighlighted : undefined}>{formatted}</span>
																					</Fragment>
																				);
																			})}
																		</span>
																	)}
																	<div className={styles.detailRowMeta}>{metaLine}</div>
																</>
															);
															if (crd) {
																const href = `/dashboard/firm/${crd}`;
																return (
																	<Link
																		href={href}
																		key={`cur-emp-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`cur-emp-${idx}`}
																	className={`${styles.detailRow} ${styles.currentEmploymentRow}`}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.previousEmployment.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Previous Employment ({detailedMainRecord.previousEmployment.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.previousEmployment.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
															const firmInfo = crd ? employmentFirmInfo[String(crd)] : undefined;
															const address = formatAddress(row.branchOfficeLocations?.[0]) || (row.city && row.state ? `${row.city}, ${row.state}` : '');
															const startDate = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
															const endDate = pickFirstNonEmpty(row.registrationEndDate, row.endDate);

															let dateStr = '';
															if (startDate && endDate) dateStr = `${startDate} - ${endDate}`;
															else if (startDate) dateStr = startDate;

															const metaParts = [address, dateStr].filter(Boolean);
															const metaLine = metaParts.length > 0 ? metaParts.join(' • ') : formatUiText(pickFirstNonEmpty(row.position, row.currentRegistration, row.status));
															const rowName = resolveEntityNodeLabel(row, 'firm', crd, idx);
															const currentFirmName = firmInfo?.firmName ? String(firmInfo.firmName).trim() : '';
															const normRowName = String(rowName || row.firmName || '')
																.toLowerCase()
																.replace(/[^a-z0-9]/g, '');
															const normCurrentFirmName = currentFirmName.toLowerCase().replace(/[^a-z0-9]/g, '');
															const isRenamed = Boolean(normCurrentFirmName && normRowName && normCurrentFirmName !== normRowName);

															let displayOtherNames = [...(firmInfo?.otherNames || [])];
															if (isRenamed && currentFirmName) {
																const alreadyInList = displayOtherNames.some(
																	(n) =>
																		String(n)
																			.toLowerCase()
																			.replace(/[^a-z0-9]/g, '') === normCurrentFirmName,
																);
																if (!alreadyInList) {
																	displayOtherNames.unshift(currentFirmName);
																}
															}

															const statusKey = resolveEmploymentStatusTag(row, firmInfo);
															const rowStatusClass = /inactive/i.test(String(statusKey)) ? styles.currentConnectionStatusTagInactive : styles.currentConnectionStatusTag;
															const sourceTags = Array.from(new Set([...(Array.isArray(row.sourceTags) ? row.sourceTags : []), row.sourceTag].filter(Boolean)));

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<div className={styles.employmentRowNameWrap}>
																			<span className={styles.detailRowName}>{rowName}</span>
																			{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																			{sourceTags.includes('FINRA') && <span className={styles.tagFinra}>FINRA</span>}
																			{sourceTags.includes('SEC') && <span className={styles.tagSec}>SEC</span>}
																			{statusKey && <span className={`${styles.detailInlineTag} ${rowStatusClass}`}>{String(statusKey)}</span>}
																		</div>
																	</div>
																	{displayOtherNames.length > 0 && (
																		<span className={styles.employmentRowOtherNames}>
																			aka{' '}
																			{displayOtherNames.map((n, nIdx) => {
																				const formatted = formatOtherName(n, true);
																				const normFormatted = String(formatted)
																					.toLowerCase()
																					.replace(/[^a-z0-9]/g, '');
																				const normRaw = String(n)
																					.toLowerCase()
																					.replace(/[^a-z0-9]/g, '');
																				const isHighlighted = isRenamed && (normFormatted === normCurrentFirmName || normRaw === normCurrentFirmName);
																				return (
																					<Fragment key={`prev-emp-other-${idx}-${nIdx}`}>
																						{nIdx > 0 && ', '}
																						<span className={isHighlighted ? styles.employmentOtherNameHighlighted : undefined}>{formatted}</span>
																					</Fragment>
																				);
																			})}
																		</span>
																	)}
																	<div className={styles.detailRowMeta}>{metaLine}</div>
																</>
															);

															if (crd) {
																const href = `/dashboard/firm/${crd}`;
																return (
																	<Link
																		href={href}
																		key={`prev-emp-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.previousEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`prev-emp-${idx}`}
																	className={`${styles.detailRow} ${styles.previousEmploymentRow}`}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord?.disclosureSummary && detailedMainRecord.disclosureSummary.length > 0 && (
												<section
													className={styles.detailSection}
													style={{ marginTop: '12px' }}>
													<button
														type='button'
														className={styles.detailToggleBar}
														onClick={() => setDetailDisclosuresOpen((open) => !open)}
														aria-expanded={detailDisclosuresOpen}>
														<h4 className={styles.detailSectionTitle}>Disclosures</h4>
														<div className={styles.detailToggleStats}>
															<span className={styles.detailToggleStat}>Count: {detailedMainRecord.disclosureSummary.reduce((acc: number, d: any) => acc + (parseInt(d.disclosureCount) || 0), 0)}</span>
														</div>
														<span className={styles.detailToggleChevron} aria-hidden='true'>{detailDisclosuresOpen ? '−' : '+'}</span>
													</button>
													{detailDisclosuresOpen && (
														<>
													<div className={styles.detailGrid}>
														{detailedMainRecord.disclosureSummary.map((d: any) => (
															<div
																key={d.disclosureType}
																className={styles.detailGridCard}>
																<div className={styles.detailRowMain}>
																	<span className={styles.detailRowName}>{d.disclosureType}</span>
																	<span className={styles.detailInlineTag}>{d.disclosureCount}</span>
																</div>
															</div>
														))}
													</div>
													{detailedMainRecord.rawDisclosures &&
														detailedMainRecord.rawDisclosures.some((dis: any) => dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0) && (
															<div
																style={{
																	marginTop: '16px',
																	display: 'flex',
																	flexDirection: 'column',
																	gap: '12px',
																}}>
																{detailedMainRecord.rawDisclosures
																	.filter((dis: any) => dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0)
																	.map((dis: any, idx: number) => {
																		const dtype = String(dis.disclosureType || dis.type || '').trim();
																		const ddate = String(dis.eventDate || dis.date || '').trim();
																		const dres = String(dis.disclosureResolution || dis.resolution || '').trim();
																		const dd = dis.disclosureDetail || {};
																		const isObj = dd && typeof dd === 'object' && !Array.isArray(dd);
																		if (!isObj) return null;

																		const allegs = String(dd['Allegations'] || dd['allegations'] || '').trim();
																		const initiatedBy = String(dd['Initiated By'] || dd['initiatedBy'] || '').trim();
																		const resolution = String(dd['Resolution'] || dd['resolution'] || '').trim();
																		const sanctionText = String(dd['Sanctions'] || dd['sanctions'] || '').trim();
																		const sanctionDetails = Array.isArray(dd['SanctionDetails'] || dd['Sanction Details']) ? dd['SanctionDetails'] || dd['Sanction Details'] : [];
																		const brokerCommentRaw = dd['Broker Comment'] || dd['brokerComment'] || null;
																		const comments =
																			Array.isArray(brokerCommentRaw) ? brokerCommentRaw
																			: brokerCommentRaw ? [brokerCommentRaw]
																			: [];
																		const settlementAmt = String(dd['Settlement Amount'] || dd['settlementAmount'] || '').trim();
																		const docketFDA = String(dd['DocketNumberFDA'] || '').trim();
																		const docketAAO = String(dd['DocketNumberAAO'] || '').trim();
																		const arbDocket = String(dd['arbitrationDocketNumber'] || '').trim();

																		const sanctionBadges = sanctionDetails
																			.map((s: any) => String(typeof s === 'object' ? s.Sanctions || s.sanctions || '' : s).trim())
																			.filter(Boolean);

																		const handledDetailKeys = new Set(
																			[
																				'Allegations',
																				'allegations',
																				'Initiated By',
																				'initiatedBy',
																				'Resolution',
																				'resolution',
																				'Sanctions',
																				'sanctions',
																				'SanctionDetails',
																				'Sanction Details',
																				'Broker Comment',
																				'brokerComment',
																				'Settlement Amount',
																				'settlementAmount',
																				'DocketNumberFDA',
																				'DocketNumberAAO',
																				'arbitrationDocketNumber',
																			].map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')),
																		);

																		const extraDetailRows = Object.entries(dd)
																			.map(([key, value]) => ({
																				key,
																				keyId: key.toLowerCase().replace(/[^a-z0-9]/g, ''),
																				valueText: String(value).trim(),
																			}))
																			.filter(({ keyId, valueText }) => valueText && !handledDetailKeys.has(keyId));

																		return (
																			<div
																				key={idx}
																				className='fg-disclosure'
																				style={{ margin: 0 }}>
																				<div className='fg-dis-header'>
																					<span className='fg-dis-type'>{dtype}</span>
																					{ddate && <span className='fg-dis-date'>{ddate}</span>}
																					{dres && <span className={`fg-dis-res ${/final|settled/i.test(dres) ? 'final' : 'pending'}`}>{dres}</span>}
																				</div>
																				{initiatedBy && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Initiated by:</span> {initiatedBy}
																					</div>
																				)}
																				{allegs && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Allegations:</span>
																						<div className='fg-dis-text'>{allegs}</div>
																					</div>
																				)}
																				{resolution && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Resolution:</span> {resolution}
																					</div>
																				)}
																				{sanctionText && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Sanctions:</span>
																						<div className='fg-dis-text'>{sanctionText}</div>
																					</div>
																				)}
																				{settlementAmt && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Settlement:</span> <strong>{settlementAmt}</strong>
																					</div>
																				)}
																				{sanctionBadges.length > 0 && (
																					<div className='fg-dis-sanctions'>
																						{sanctionBadges.map((s: any, i: number) => (
																							<span
																								key={i}
																								className='fg-badge inactive'>
																								{s}
																							</span>
																						))}
																					</div>
																				)}
																				{comments.length > 0 && (
																					<div className='fg-dis-row'>
																						<span className='fg-dis-label'>Broker comment:</span>
																						<div className='fg-dis-text fg-dis-comment'>
																							{comments.map((c: any, i: number) => (
																								<div key={i}>{String(c)}</div>
																							))}
																						</div>
																					</div>
																				)}
																				{(docketFDA || docketAAO || arbDocket) && (
																					<div className='fg-dis-row fg-dis-dockets'>
																						{[docketFDA && `FDA: ${docketFDA}`, docketAAO && `AAO: ${docketAAO}`, arbDocket && `Arb: ${arbDocket}`].filter(Boolean).join('  |  ')}
																					</div>
																				)}
																				{extraDetailRows.map(({ key, valueText }, i) => (
																					<div
																						key={`extra-${i}`}
																						className='fg-dis-row'>
																						<span className='fg-dis-label'>{key}:</span>
																						<div className='fg-dis-text'>{valueText}</div>
																					</div>
																				))}
																			</div>
																		);
																	})}
															</div>
														)}
														</>
													)}
												</section>
											)}

											{detailedMainRecord.directOwners?.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Direct Owners & Executive Officers ({detailedMainRecord.directOwners.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.directOwners.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.individualId);
															const name = resolveEntityNodeLabel(row, 'individual', crd, idx);
															const position = formatUiText(pickFirstNonEmpty(row.position, row.title));
															const acquiredDate = pickFirstNonEmpty(row.acquiredDate, row.dateAcquired, row.startDate);
															const addressText = [toText(row.city), toText(row.state)].filter(Boolean).join(', ');
															const metaParts = [position, acquiredDate ? `Acquired: ${acquiredDate}` : '', addressText].filter(Boolean);
															const ownerBcScope = String(row.bcScope || row.bc_scope || '')
																.trim()
																.toLowerCase()
																.replace(/\s+/g, '');
															const isNonLiveOwner = !ownerBcScope || ownerBcScope === 'notinscope';
															const parentFirmStatus = pickFirstNonEmpty(
																detailedMainRecord.basicInformation?.firmStatus,
																detailedMainRecord.basicInformation?.bcScope,
																(mainJson as any)?.basicInformation?.firmStatus,
																(mainJson as any)?.firmStatus,
															);
															const ownerHref =
																crd && currentRecordEntity === 'firm' && currentRecordId ?
																	buildNonLiveOwnerDashboardHref({
																		crd,
																		parentCrd: currentRecordId,
																		name: pickFirstNonEmpty(row.legalName, row.name, name),
																		position,
																		firmName: detailedMainRecord.name,
																		firmStatus: parentFirmStatus,
																		isNonLive: isNonLiveOwner,
																	})
																:	crd ? `/dashboard/individual/${crd}`
																:	'';

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{name}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	{metaParts.length > 0 && <div className={styles.detailRowMeta}>{metaParts.join(' • ')}</div>}
																</>
															);

															if (crd && ownerHref) {
																return (
																	<Link
																		href={ownerHref}
																		key={`dir-owner-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`dir-owner-${idx}`}
																	className={styles.detailRow}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.indirectOwners?.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Indirect Owners ({detailedMainRecord.indirectOwners.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.indirectOwners.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.individualId);
															const name = resolveEntityNodeLabel(row, 'individual', crd, idx);
															const position = formatUiText(pickFirstNonEmpty(row.position, row.title));
															const acquiredDate = pickFirstNonEmpty(row.acquiredDate, row.dateAcquired, row.startDate);
															const addressText = [toText(row.city), toText(row.state)].filter(Boolean).join(', ');
															const metaParts = [position, acquiredDate ? `Acquired: ${acquiredDate}` : '', addressText].filter(Boolean);
															const ownerBcScope = String(row.bcScope || row.bc_scope || '')
																.trim()
																.toLowerCase()
																.replace(/\s+/g, '');
															const isNonLiveOwner = !ownerBcScope || ownerBcScope === 'notinscope';
															const parentFirmStatus = pickFirstNonEmpty(
																detailedMainRecord.basicInformation?.firmStatus,
																detailedMainRecord.basicInformation?.bcScope,
																(mainJson as any)?.basicInformation?.firmStatus,
																(mainJson as any)?.firmStatus,
															);
															const ownerHref =
																crd && currentRecordEntity === 'firm' && currentRecordId ?
																	buildNonLiveOwnerDashboardHref({
																		crd,
																		parentCrd: currentRecordId,
																		name: pickFirstNonEmpty(row.legalName, row.name, name),
																		position,
																		firmName: detailedMainRecord.name,
																		firmStatus: parentFirmStatus,
																		isNonLive: isNonLiveOwner,
																	})
																:	crd ? `/dashboard/individual/${crd}`
																:	'';

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{name}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	{metaParts.length > 0 && <div className={styles.detailRowMeta}>{metaParts.join(' • ')}</div>}
																</>
															);

															if (crd && ownerHref) {
																return (
																	<Link
																		href={ownerHref}
																		key={`indir-owner-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`indir-owner-${idx}`}
																	className={styles.detailRow}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.stateExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>🏛️ STATE EXAM CATEGORY ({detailedMainRecord.stateExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.stateExams.map((row, idx) => (
															<div
																key={`state-exam-${idx}`}
																className={styles.detailExamCardState}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgeState}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.productExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>📜 PRODUCT EXAM CATEGORY ({detailedMainRecord.productExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.productExams.map((row, idx) => (
															<div
																key={`prod-exam-${idx}`}
																className={styles.detailExamCardProduct}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgeProduct}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.principalExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>👔 PRINCIPAL EXAM CATEGORY ({detailedMainRecord.principalExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.principalExams.map((row, idx) => (
															<div
																key={`princ-exam-${idx}`}
																className={styles.detailExamCardPrincipal}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgePrincipal}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.brochureCards.length > 0 && (
												<section className={styles.detailSection}>
													<button
														type='button'
														className={styles.detailToggleBar}
														onClick={() => setDetailBrochuresOpen((open) => !open)}
														aria-expanded={detailBrochuresOpen}>
														<h4 className={styles.detailSectionTitle}>Brochures</h4>
														<div className={styles.detailToggleStats}>
															<span className={styles.detailToggleStat}>Count: {detailedMainRecord.brochureCards.length}</span>
														</div>
														<span className={styles.detailToggleChevron} aria-hidden='true'>{detailBrochuresOpen ? '−' : '+'}</span>
													</button>
													{detailBrochuresOpen && (
														<>
													{detailedMainRecord.brochuresPart2Exempt && (
														<div
															className={styles.detailTextRow}
															style={{ marginBottom: '6px' }}>
															<strong>Part 2 Exempt:</strong> {detailedMainRecord.brochuresPart2Exempt}
														</div>
													)}
													<div className={styles.detailGrid}>
														{detailedMainRecord.brochureCards.map((item, idx) => (
															<div
																key={`brochure-${idx}`}
																className={styles.detailGridCard}>
																<div className={styles.detailRowMain}>
																	<span className={styles.detailRowName}>{item.title}</span>
																	{item.meta && <span className={styles.detailInlineTag}>{item.meta}</span>}
																</div>
																{item.subtitle && <div className={styles.detailRowMeta}>{item.subtitle}</div>}
															</div>
														))}
													</div>
														</>
													)}
												</section>
											)}

											{detailedMainRecord.noticeFilingCards.length > 0 && (
												<section className={styles.detailSection}>
													<button
														type='button'
														className={styles.detailToggleBar}
														onClick={() => setDetailNoticeFilingsOpen((open) => !open)}
														aria-expanded={detailNoticeFilingsOpen}>
														<h4 className={styles.detailSectionTitle}>Notice Filings</h4>
														<div className={styles.detailToggleStats}>
															<span className={styles.detailToggleStat}>Count: {detailedMainRecord.noticeFilingCards.length}</span>
														</div>
														<span className={styles.detailToggleChevron} aria-hidden='true'>{detailNoticeFilingsOpen ? '−' : '+'}</span>
													</button>
													{detailNoticeFilingsOpen && (
														<>
													<div className={styles.detailGrid}>
														{detailedMainRecord.noticeFilingCards.map((item, idx) => (
															<div
																key={`notice-filing-${idx}`}
																className={styles.detailGridCard}>
																<div className={styles.detailRowMain}>
																	<span className={styles.detailRowName}>{item.title}</span>
																	{item.meta && <span className={styles.detailInlineTag}>{item.meta}</span>}
																</div>
																{item.subtitle && <div className={styles.detailRowMeta}>Effective Date: {item.subtitle}</div>}
															</div>
														))}
													</div>
														</>
													)}
												</section>
											)}

											{detailedMainRecord.jurisdictionCards.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Registered States ({detailedMainRecord.jurisdictionCards.length})</h4>
													<div className={styles.detailTagList}>
														{detailedMainRecord.jurisdictionCards.map((item, idx) => (
															<span
																key={`${item.title}-${idx}`}
																className={styles.detailTagState}>
																{item.title}
															</span>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.registeredSros.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Registered SROs ({detailedMainRecord.registeredSros.length})</h4>
													<div className={styles.detailTagList}>
														{detailedMainRecord.registeredSros.map((tag) => (
															<span
																key={tag}
																className={styles.detailTagSro}>
																{tag}
															</span>
														))}
													</div>
												</section>
											)}

											{(
												currentRecordEntity === 'firm' &&
												connectionsLoadingFirmId === currentRecordId &&
												detailedMainRecord.currentConnectionCards.length === 0 &&
												detailedMainRecord.previousConnectionCards.length === 0
											) ?
												<section
													id={FIRM_CONNECTIONS_ANCHOR_ID}
													className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Loading connections…</h4>
												</section>
											:	(() => {
													type ConnectionCard = (typeof detailedMainRecord.currentConnectionCards)[number];
													const connectionKey = (item: { crd?: string; entity?: string }) => (item.crd ? `${item.entity || 'individual'}:${item.crd}` : '');
													const matchedSelectableCurrent = currentConnectionPartition.matched.filter((item) => item.crd);
													const matchedSelectablePrevious = previousConnectionPartition.matched.filter((item) => item.crd);
													const matchedSelectableConnections = [...matchedSelectableCurrent, ...matchedSelectablePrevious];
													const selectableConnections = [...filteredCurrentConnectionCardsAll, ...filteredPreviousConnectionCardsAll].filter((item) => item.crd);
													const currentMatchedSet = currentConnectionPartition.matchedSet as Set<ConnectionCard>;
													const previousMatchedSet = previousConnectionPartition.matchedSet as Set<ConnectionCard>;
													const filterHighlightActive =
														!connectionFilterPreviewUnfiltered &&
														(Boolean(connectionsFilterQuery.trim()) || (connectionsFilterEnabled && connectionsFilterTags.length > 0));
													const toggleConnectionKey = (key: string) => {
														if (!key) return;
														setSelectedConnectionKeys((prev) => {
															const next = new Set(prev);
															if (next.has(key)) next.delete(key);
															else next.add(key);
															return next;
														});
													};
													const selectConnectionGroup = (group: 'all' | 'current' | 'previous') => {
														const items =
															group === 'current' ? matchedSelectableCurrent
															: group === 'previous' ? matchedSelectablePrevious
															: matchedSelectableConnections;
														setSelectedConnectionKeys(new Set(items.map((item) => connectionKey(item)).filter(Boolean)));
													};
													const finishConnectionSelectMode = () => {
														const selected = selectableConnections.filter((item) => selectedConnectionKeys.has(connectionKey(item)));
														if (selected.length) {
															const currentCrdSet = new Set((detailedMainRecord?.currentConnectionCards || []).map((item) => String(item.crd || '').trim()).filter(Boolean));
															const people: QueueGraphBridgePerson[] = selected
																.filter((item) => item.entity !== 'firm' && item.crd)
																.map((item) => ({
																	crd: String(item.crd),
																	name: item.title,
																	isCurrent: currentCrdSet.has(String(item.crd)),
																}));
															const nodeIds = selected.map((item) => (item.entity === 'firm' ? `firm:${item.crd}` : `person:${item.crd}`)).filter(Boolean);
															const firmId = currentRecordEntity === 'firm' && currentRecordId ? String(currentRecordId) : undefined;
															const firmName = firmId ? formatFirmName(pickFirstNonEmpty(mainJsonLabel, `Firm ${firmId}`) || `Firm ${firmId}`) : undefined;
															if (firmId) nodeIds.unshift(`firm:${firmId}`);
															const bridgeSeed = {
																nodeIds: Array.from(new Set(nodeIds)),
																people,
																anchorFirmId: firmId,
																anchorFirmName: firmName,
															};
															pendingQueueGraphSeed = bridgeSeed;
															writeQueueGraphBridge(bridgeSeed.nodeIds, {
																anchorFirmId: bridgeSeed.anchorFirmId,
																anchorFirmName: bridgeSeed.anchorFirmName,
																people: bridgeSeed.people,
															});
															recordHistoryEntries(
																selected.map((item) => ({
																	id: String(item.crd),
																	entity: item.entity === 'firm' ? 'firm' : 'individual',
																	sources: ['finra', 'sec'],
																	name: item.title,
																})),
															);
														}
														setConnectionsSelectMode(false);
														setSelectedConnectionKeys(new Set());
													};

													const renderConnectionRow = (item: (typeof filteredCurrentConnectionCards)[number], idx: number, kind: 'current' | 'previous') => {
														const key = connectionKey(item);
														const isSelected = connectionsSelectMode && Boolean(key) && selectedConnectionKeys.has(key);
														const isUnmatched = !(kind === 'current' ? currentMatchedSet.has(item) : previousMatchedSet.has(item));
														const nameClass = kind === 'current' ? styles.currentConnectionName : styles.previousConnectionName;
														const otherNamesClass = kind === 'current' ? styles.currentConnectionOtherNames : styles.previousConnectionOtherNames;
														const metaClass = kind === 'current' ? styles.currentConnectionMeta : styles.previousConnectionMeta;
														const rowKindClass = kind === 'current' ? styles.currentConnectionRow : styles.previousConnectionRow;
														const unmatchedClass = isUnmatched ? styles.connectionFilterUnmatched : '';
														const liveHighlight =
															isUnmatched || !filterHighlightActive ? '' : [connectionsFilterQuery.trim(), ...connectionsFilterTags].filter(Boolean).join(' ');
														const dateStr =
															kind === 'current' ?
																item.startDate ?
																	`Since ${item.startDate}`
																:	''
															: item.startDate && item.endDate ? `${item.startDate} - ${item.endDate}`
															: item.startDate || item.endDate || '';
														const otherNames = (item.otherNames || []).map((n) => formatOtherName(n, true)).filter(Boolean);
														const visitedPerson =
															item.entity === 'individual' && item.crd ?
																dashboardRecordSnapshotCache.get(`individual:${item.crd}`)?.payload ||
																readVisitedSync<any>(visitSnapshotKey('individual', item.crd))?.payload ||
																readVisitedSync<any>(visitDetailKey('individual', item.crd))
															:	null;
														const sourceTags = Array.from(
															new Set(
																[
																	...(item.sourceTags || []),
																	...(visitedPerson && (visitedPerson.hasFinraData === true || hasIndividualSourceCoverage(visitedPerson, 'finra')) ? ['FINRA'] : []),
																	...(visitedPerson && (visitedPerson.hasSecData === true || hasIndividualSourceCoverage(visitedPerson, 'sec')) ? ['SEC'] : []),
																].filter(Boolean),
															),
														);
														const statusKey = resolveEmploymentStatusTag(item);
														const rowStatusClass = /inactive/i.test(String(statusKey)) ? styles.currentConnectionStatusTagInactive : styles.currentConnectionStatusTag;
														const metaLine = [item.address, dateStr].filter(Boolean).join(' • ');
														const visitedCurrentEmployer =
															kind === 'previous' && visitedPerson ?
																(() => {
																	const employments = [...toArray(visitedPerson?.currentEmployments), ...toArray(visitedPerson?.currentIAEmployments)];
																	const excludeFirmId = String(currentRecordId || '');
																	const match =
																		employments.find((emp: any) => {
																			const id = String(pickFirstValidCrd(emp?.firmId, emp?.firm_id, emp?.crdNumber, emp?.crd) || '');
																			return id && id !== excludeFirmId;
																		}) || employments[0];
																	if (!match) return null;
																	return {
																		currentFirmId: pickFirstValidCrd(match?.firmId, match?.firm_id, match?.crdNumber, match?.crd) || undefined,
																		currentFirmName: pickFirstNonEmpty(match?.firmName, match?.iaFirmName, match?.legalName, match?.name) || undefined,
																	};
																})()
															:	null;
														const currentFirmId = item.currentFirmId || visitedCurrentEmployer?.currentFirmId;
														const currentFirmName = item.currentFirmName || visitedCurrentEmployer?.currentFirmName;
														const currentEmployerLabel =
															kind === 'previous' && (currentFirmName || currentFirmId) ?
																['curr:', currentFirmName ? formatFirmName(currentFirmName) : 'Firm', currentFirmId ? `CRD#${currentFirmId}` : ''].filter(Boolean).join(' ')
															:	'';
														const content = (
															<>
																<div className={styles.detailRowMain}>
																	<div className={styles.employmentRowNameWrap}>
																		<span className={`${styles.detailRowName} ${nameClass}`}>{highlightConnectionMatch(item.title, liveHighlight)}</span>
																		{item.crd && <span className={styles.detailInlineTag}>CRD#{item.crd}</span>}
																		{sourceTags.includes('FINRA') && <span className={styles.tagFinra}>FINRA</span>}
																		{sourceTags.includes('SEC') && <span className={styles.tagSec}>SEC</span>}
																		{statusKey && <span className={`${styles.detailInlineTag} ${rowStatusClass}`}>{String(statusKey)}</span>}
																	</div>
																</div>
																{otherNames.length > 0 && (
																	<span className={styles.employmentRowOtherNames}>
																		aka{' '}
																		{otherNames.map((name, nameIdx) => (
																			<Fragment key={`${kind}-aka-${idx}-${nameIdx}`}>
																				{nameIdx > 0 ? ', ' : ''}
																				{highlightConnectionMatch(name, liveHighlight)}
																			</Fragment>
																		))}
																	</span>
																)}
																{(metaLine || (item.meta && !/^current registration|previous registration$/i.test(item.meta))) && (
																	<div className={`${styles.detailRowMeta} ${metaClass}`}>{metaLine || item.meta}</div>
																)}
																{currentEmployerLabel && <div className={`${styles.detailRowMeta} ${metaClass}`}>{currentEmployerLabel}</div>}
															</>
														);

														if (connectionsSelectMode && key) {
															return (
																<button
																	type='button'
																	key={`${kind}-conn-${idx}`}
																	className={`${styles.detailRow} ${styles.detailRowInteractive} ${kind === 'current' ? styles.currentEmploymentRow : ''} ${rowKindClass} ${unmatchedClass} ${styles.connectionSelectRow} ${isSelected ? styles.connectionSelectRowSelected : ''}`}
																	onClick={() => toggleConnectionKey(key)}>
																	<input
																		type='checkbox'
																		checked={isSelected}
																		readOnly
																		tabIndex={-1}
																		aria-hidden='true'
																	/>
																	<div>{content}</div>
																</button>
															);
														}

														if (item.crd) {
															const entity = item.entity || 'individual';
															return (
																<Link
																	href={`/dashboard/${entity}/${item.crd}`}
																	key={`${kind}-conn-${idx}`}
																	className={`${styles.detailRow} ${styles.detailRowInteractive} ${kind === 'current' ? styles.currentEmploymentRow : ''} ${rowKindClass} ${unmatchedClass}`}>
																	{content}
																</Link>
															);
														}

														return (
															<div
																key={`${kind}-conn-${idx}`}
																className={`${styles.detailRow} ${rowKindClass} ${unmatchedClass}`}>
																{content}
															</div>
														);
													};

													return (
														<>
															{(detailedMainRecord.currentConnectionCards.length > 0 || detailedMainRecord.previousConnectionCards.length > 0) && (
																<div
																	id={FIRM_CONNECTIONS_ANCHOR_ID}
																	className={`${styles.filterLine} ${styles.filterLineSticky}`}>
																	<div className={styles.filterTagsRow}>
																		<label className={styles.filterEnabledLabel}>
																			<input
																				type='checkbox'
																				checked={connectionsFilterEnabled}
																				onChange={(event) => setConnectionsFilterEnabled(event.target.checked)}
																				aria-label='Apply committed filter tags'
																			/>
																			Tags
																		</label>
																		<FilterTagsInput
																			tags={connectionsFilterEnabled ? connectionsFilterTags : []}
																			liveText={connectionsFilterQuery}
																			onTagsChange={setConnectionsFilterTags}
																			onLiveTextChange={(text) => {
																				if (text.trim()) setConnectionsFilterJustCommitted(false);
																				setConnectionsFilterQuery(text);
																			}}
																			onFocusChange={(focused) => {
																				setConnectionsFilterFocused(focused);
																				if (!focused) setConnectionsFilterJustCommitted(false);
																			}}
																			onCommitTag={() => setConnectionsFilterJustCommitted(true)}
																			placeholder='Filter connections… name or CRD'
																		/>
																	</div>
																	<div className={styles.filterActionsRow}>
																		{connectionsFilterTags.length > 0 && (
																			<button
																				type='button'
																				className={styles.filterLineBtn}
																				onClick={() => setConnectionsFilterTags([])}
																				title='Clear committed filter tags'>
																				Clear tags
																			</button>
																		)}
																		{connectionsSelectMode ?
																			<>
																				<button
																					type='button'
																					className={styles.filterLineBtn}
																					onClick={() => selectConnectionGroup('all')}>
																					Select all
																				</button>
																				<button
																					type='button'
																					className={styles.filterLineBtn}
																					onClick={() => selectConnectionGroup('current')}>
																					Current
																				</button>
																				<button
																					type='button'
																					className={styles.filterLineBtn}
																					onClick={() => selectConnectionGroup('previous')}>
																					Previous
																				</button>
																				<button
																					type='button'
																					className={`${styles.filterLineBtn} ${styles.filterLineBtnActive}`}
																					onClick={finishConnectionSelectMode}>
																					Done{selectedConnectionKeys.size ? ` (${selectedConnectionKeys.size})` : ''}
																				</button>
																			</>
																		:	<button
																				type='button'
																				className={styles.filterLineBtn}
																				onClick={() => {
																					setConnectionsSelectMode(true);
																					setSelectedConnectionKeys(new Set());
																				}}>
																				Select mode
																			</button>
																		}
																	</div>
																</div>
															)}

															{filteredCurrentConnectionCards.length > 0 && (
																<section className={styles.detailSection}>
																	<h4 className={styles.detailSectionTitle}>Current Connections ({detailedMainRecord.currentConnectionCards.length})</h4>
																	<div className={styles.detailList}>{filteredCurrentConnectionCards.map((item, idx) => renderConnectionRow(item, idx, 'current'))}</div>
																	<ConnectionsLazySentinel
																		rootRef={dashboardContentRef}
																		enabled={currentRenderCount < filteredCurrentConnectionCardsAll.length}
																		page={currentRenderCount}
																		onLoadMore={loadMoreCurrentConnections}
																	/>
																</section>
															)}

															{filteredPreviousConnectionCards.length > 0 && (
																<section className={styles.detailSection}>
																	<h4 className={styles.detailSectionTitle}>Previous Connections ({detailedMainRecord.previousConnectionCards.length})</h4>
																	<div className={styles.detailList}>{filteredPreviousConnectionCards.map((item, idx) => renderConnectionRow(item, idx, 'previous'))}</div>
																	<ConnectionsLazySentinel
																		rootRef={dashboardContentRef}
																		enabled={previousRenderCount < filteredPreviousConnectionCardsAll.length}
																		page={previousRenderCount}
																		onLoadMore={loadMorePreviousConnections}
																	/>
																</section>
															)}
														</>
													);
												})()
											}
										</>
									:	<div className={styles.readableCardEmpty}>No readable fields found for this record.</div>}
								</div>
							)}

							{!hasCurrentRecord && <div className={styles.searchSummary}>No node selected yet. Search for a firm, person, or CRD above.</div>}
						</div>
					</div>
				</section>

				<aside className={styles.middlePane}>
					<div
						className={styles.middlePaneHeader}
						style={{ cursor: 'pointer', userSelect: 'none' }}
						onClick={() => setIsSelectionHistoryOpen(!isSelectionHistoryOpen)}>
						<div className={styles.middlePaneTitle}> Queue graph {isSelectionHistoryOpen ? '▼' : '▶'}</div>
						<div className={styles.middlePaneActions}>
							<span className={styles.middlePaneCount}>{displayCards.length}</span>
							{isSelectionHistoryEditMode && selectedHistoryIds.size > 0 && (
								<button
									type='button'
									className={styles.middlePaneClearBtn}
									onClick={(e) => {
										e.stopPropagation();
										deleteSelectedHistoryEntries();
									}}>
									DELETE ({selectedHistoryIds.size})
								</button>
							)}
							<button
								type='button'
								className={styles.middlePaneClearBtn}
								onClick={(e) => {
									e.stopPropagation();
									toggleSelectionHistoryEditMode();
								}}>
								{isSelectionHistoryEditMode ? 'DONE' : 'EDIT'}
							</button>
							<button
								type='button'
								className={styles.middlePaneClearBtn}
								onClick={(e) => {
									e.stopPropagation();
									clearSelectionHistory();
								}}>
								CLEAR
							</button>
						</div>
					</div>

					{isSelectionHistoryOpen && (
						<div
							className={styles.middlePaneList}
							style={{ flex: 1, minHeight: 0 }}>
							{displayCards.length > 0 ?
								displayCards.map((card) =>
									(() => {
										const isActiveRecord = currentRecordId === card.id && currentRecordEntity === card.entity;
										const storedName = toText(card.name);
										const computedCardName =
											storedName && !looksLikeGenericEntityLabel(storedName) ? storedName
											: isActiveRecord && toText(mainJsonLabel) ? toText(mainJsonLabel)
											: `${card.entity === 'firm' ? 'Firm' : 'Individual'} CRD #${card.id}`;
										const { hasFinra, hasSec } = getQueueCardSources(card);
										const historyKey = `${card.entity}:${card.id}`;
										const isChecked = selectedHistoryIds.has(historyKey);

										return (
											<button
												type='button'
												key={historyKey}
												className={`${styles.middlePaneItem} ${isActiveRecord ? styles.middlePaneItemSelected : ''}`}
												aria-selected={isActiveRecord}
												style={{
													display: 'flex',
													flexDirection: 'column',
													width: '100%',
													textAlign: 'left',
												}}
												onClick={() => {
													if (isSelectionHistoryEditMode) {
														toggleSelectedHistoryId(historyKey);
														return;
													}
													void openQueueCard(card);
												}}>
												<div className={styles.middlePaneItemTop}>
													{isSelectionHistoryEditMode && (
														<input
															type='checkbox'
															checked={isChecked}
															onChange={() => toggleSelectedHistoryId(historyKey)}
															onClick={(e) => e.stopPropagation()}
															style={{ marginRight: '4px' }}
														/>
													)}
													<span className={styles.middlePaneItemBadge}>{card.entity === 'firm' ? 'FIRM' : 'IND'}</span>
													<span className={styles.middlePaneItemName}>{computedCardName}</span>
													<div className={styles.cardTags}>
														{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
														{hasSec && <span className={styles.tagSec}>SEC</span>}
													</div>
												</div>
												<div className={styles.middlePaneItemMeta}>CRD #{card.id}</div>
											</button>
										);
									})(),
								)
							:	<div className={styles.middlePaneEmpty}>No selection history yet.</div>}
						</div>
					)}
				</aside>

				<div
					className={styles.rightColumn}
					data-right-open={String(newCrdsOpen)}>
					<aside
						className={`${styles.rightPane} ${!newCrdsOpen ? styles.rightPaneCompact : ''}`}
						aria-hidden={!newCrdsOpen}>
						{newCrdsOpen && (
							<>
								<div className={styles.rightPaneCountCard}>newly added CRDs, 32 of {uniqueCrdCounts.total.toLocaleString()} </div>

								<div className={styles.rightPaneSection}>
									<div className={styles.rightPaneSectionTitle}>PEOPLE</div>
									<div className={styles.rightPaneList}>
										{peopleCrdEntries.length > 0 ?
											peopleCrdEntries.map((entry) => {
												const isSelected = currentRecordId === entry.id && currentRecordEntity === 'individual';
												const { hasFinra, hasSec } = getNewCrdSources(entry, 'individual', localHistory);
												return (
													<button
														type='button'
														key={`people-${entry.id}`}
														className={`${styles.rightPaneItem} ${isSelected ? styles.rightPaneItemSelected : ''}`}
														aria-selected={isSelected}
														onClick={() => void openNewCrdEntry(entry)}>
														<div className={styles.rightPaneItemTop}>
															<div className={styles.rightPaneItemTitleRow}>
																<svg
																	className={styles.itemEntityIcon}
																	viewBox='0 0 24 24'
																	fill='none'
																	stroke='currentColor'
																	strokeWidth='2'
																	strokeLinecap='round'
																	strokeLinejoin='round'
																	aria-hidden='true'>
																	<path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' />
																	<circle
																		cx='12'
																		cy='7'
																		r='4'
																	/>
																</svg>
																<span className={styles.rightPaneItemTitle}>
																	{toText(entry.name) ||
																		historyNameMap.get(`individual:${entry.id}`) ||
																		getRecordDisplayName(entry as unknown as Record<string, unknown>, 'individual', entry.id) ||
																		extractDisplayNameFromNewCrd(entry, 'individual')}
																</span>
															</div>
															<div className={styles.cardTags}>
																{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
																{hasSec && <span className={styles.tagSec}>SEC</span>}
															</div>
														</div>
														<div className={styles.rightPaneItemMeta}>CRD #{entry.id}</div>
													</button>
												);
											})
										:	<div className={styles.rightPaneEmpty}>No people queued yet.</div>}
									</div>
								</div>

								<div className={styles.rightPaneSection}>
									<div className={styles.rightPaneSectionTitle}>FIRMS</div>
									<div className={styles.rightPaneList}>
										{firmCrdEntries.length > 0 ?
											firmCrdEntries.map((entry) => {
												const isSelected = currentRecordId === entry.id && currentRecordEntity === 'firm';
												const { hasFinra, hasSec } = getNewCrdSources(entry, 'firm', localHistory);
												return (
													<button
														type='button'
														key={`firm-${entry.id}`}
														className={`${styles.rightPaneItem} ${isSelected ? styles.rightPaneItemSelected : ''}`}
														aria-selected={isSelected}
														onClick={() => void openNewCrdEntry(entry)}>
														<div className={styles.rightPaneItemTop}>
															<div className={styles.rightPaneItemTitleRow}>
																<svg
																	className={styles.itemEntityIcon}
																	viewBox='0 0 24 24'
																	fill='none'
																	stroke='currentColor'
																	strokeWidth='2'
																	strokeLinecap='round'
																	strokeLinejoin='round'
																	aria-hidden='true'>
																	<rect
																		x='4'
																		y='2'
																		width='16'
																		height='20'
																		rx='2'
																		ry='2'
																	/>
																	<path d='M9 22v-4h6v4' />
																	<path d='M8 6h.01' />
																	<path d='M16 6h.01' />
																	<path d='M12 6h.01' />
																	<path d='M12 10h.01' />
																	<path d='M12 14h.01' />
																	<path d='M16 10h.01' />
																	<path d='M16 14h.01' />
																	<path d='M8 10h.01' />
																	<path d='M8 14h.01' />
																</svg>
																<span className={styles.rightPaneItemTitle}>
																	{toText(entry.name) ||
																		historyNameMap.get(`firm:${entry.id}`) ||
																		getRecordDisplayName(entry as unknown as Record<string, unknown>, 'firm', entry.id) ||
																		extractDisplayNameFromNewCrd(entry, 'firm')}
																</span>
															</div>
															<div className={styles.cardTags}>
																{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
																{hasSec && <span className={styles.tagSec}>SEC</span>}
															</div>
														</div>
														<div className={styles.rightPaneItemMeta}>CRD #{entry.id}</div>
													</button>
												);
											})
										:	<div className={styles.rightPaneEmpty}>No firms queued yet.</div>}
									</div>
								</div>
							</>
						)}
					</aside>
				</div>
			</div>
			<div className={styles.hiddenValues}>
				<input
					type='text'
					value={externalRawDir}
					onChange={(event) => setExternalRawDir(event.target.value)}
				/>
			</div>
		</div>
	);
}

export default function DashboardPage() {
	return (
		<Suspense
			fallback={
				<div className={styles.page}>
					<div className={styles.layout}>
						<section className={styles.centerPane}>
							<div className={styles.searchSummary}>
								<VectorLoader
									size='lg'
									label='Loading dashboard…'
								/>
							</div>
						</section>
					</div>
				</div>
			}>
			<DashboardPageInner />
		</Suspense>
	);
}
