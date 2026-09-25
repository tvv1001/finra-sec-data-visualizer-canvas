'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import ThemeToggle from './ThemeToggle';
import { applyStickyParamsToUrl, buildNodeRouteHref, buildNodeRoutePath, parseNodeIdFromPathname } from '@/lib/node-route';
import { RUNTIME_CLICK_EXPANSION_HOPS, RUNTIME_EXPANSION_HOPS, RUNTIME_SELECTION_HOPS } from '@/lib/finra-graph-defaults';
import { consumeQueueGraphBridgePayload } from '@/lib/queueGraphBridge';
import {
	GPU_RENDERER_STORAGE_KEY,
	GPU_TIER_STORAGE_KEY,
	HYBRID_GPU_STORAGE_KEY,
	SAFE_GPU_STORAGE_KEY,
	applySafeGpuDomState,
	probeWebGlGpuInfo,
	resolveSafeGpuEnabled,
} from '@/lib/gpu-capability';

const MOBILE_TOUCH_SLOP_PX = 12;
const MOBILE_TOUCH_CLICK_SUPPRESSION_MS = 250;
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';
const FIND_QUERY_EVENT = 'finra:find-query';
const FIND_NEXT_EVENT = 'finra:find-next';
const FIND_PREV_EVENT = 'finra:find-prev';
const FIND_MOVE_EVENT = 'finra:find-move';
const FIND_CLOSE_EVENT = 'finra:find-close';
const FIND_STATE_EVENT = 'finra:find-state';
const MOBILE_FIND_CLOSE_REQUEST_EVENT = 'finra:mobile-find-close-request';

function buildDashboardHrefFromNodeId(nodeId: string | null | undefined) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;
	const separatorIndex = normalizedNodeId.indexOf(':');
	if (separatorIndex < 0) return null;
	const type = normalizedNodeId.slice(0, separatorIndex).trim().toLowerCase();
	const rawId = normalizedNodeId.slice(separatorIndex + 1).trim();
	if (!rawId) return null;
	if (type === 'person' || type === 'individual') return `/dashboard/individual/${encodeURIComponent(rawId)}`;
	if (type === 'firm') return `/dashboard/firm/${encodeURIComponent(rawId)}`;
	return null;
}

function getLatestDashboardHrefFromSelectionLog() {
	if (typeof window === 'undefined') return null;
	try {
		const raw = localStorage.getItem('finra_selection_log');
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || !parsed.length) return null;

		for (let index = parsed.length - 1; index >= 0; index -= 1) {
			const entry = parsed[index];
			const candidateNodeId = String(entry?.id || '').trim();
			const href = buildDashboardHrefFromNodeId(candidateNodeId);
			if (href) return href;
		}
	} catch {
		return null;
	}
	return null;
}

function bindTouchDragClickSuppression(button: HTMLElement | null) {
	if (!button || button.dataset.touchGuardBound === 'true') return;
	button.dataset.touchGuardBound = 'true';

	let activePointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let suppressClickUntil = 0;

	const movedBeyondTouchSlop = (clientX: number, clientY: number) => Math.hypot(clientX - startX, clientY - startY) > MOBILE_TOUCH_SLOP_PX;
	const suppressNextClick = () => {
		suppressClickUntil = Date.now() + MOBILE_TOUCH_CLICK_SUPPRESSION_MS;
	};

	button.addEventListener(
		'pointerdown',
		(event) => {
			if (event.pointerType !== 'touch') return;
			activePointerId = event.pointerId;
			startX = event.clientX;
			startY = event.clientY;
		},
		{ passive: true },
	);

	button.addEventListener(
		'pointermove',
		(event) => {
			if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
			if (!movedBeyondTouchSlop(event.clientX, event.clientY)) return;
			suppressNextClick();
			activePointerId = null;
		},
		{ passive: true },
	);

	const finalizePointer = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
		if (movedBeyondTouchSlop(event.clientX, event.clientY)) {
			suppressNextClick();
		}
		activePointerId = null;
	};

	button.addEventListener('pointerup', finalizePointer, { passive: true });
	button.addEventListener('pointercancel', finalizePointer, { passive: true });
	button.addEventListener(
		'click',
		(event) => {
			// handleNodeOpen(event);
			if (Date.now() >= suppressClickUntil) return;
			event.preventDefault();
			event.stopPropagation();
		},
		true,
	);
}

function ensureSidebarHintContent() {
	const inner = document.getElementById('fg-sidebar-inner');
	if (!inner) return;
	const hasRenderableContent = inner.children.length > 0 || Boolean(inner.textContent?.trim());
	if (!hasRenderableContent) {
		inner.innerHTML = ` `;
	}
}

function isSidebarTemporarilyPinned() {
	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar || sidebar.classList.contains('hidden')) return false;
	const isExpanded = sidebar.dataset.mobileExpanded === 'true';
	const viewMode = sidebar.dataset.viewMode;
	return isExpanded && (viewMode === 'info' || viewMode === 'log');
}

function isSidebarPersistentlyPinned() {
	return document.getElementById('fg-sidebar')?.dataset.persistentPinned === 'true';
}

function syncSidebarPinButton(pinned: boolean) {
	const btn = document.getElementById('fg-sidebar-pin-toggle');
	if (!btn) return;
	btn.setAttribute('aria-pressed', String(pinned));
	btn.setAttribute('data-pinned', String(pinned));
	btn.title = pinned ? 'Unpin panel' : 'Pin panel open';
	btn.setAttribute('aria-label', pinned ? 'Unpin panel' : 'Pin panel open');
}

function toggleSidebarPin() {
	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar) return;
	const pinned = sidebar.dataset.persistentPinned !== 'true';
	sidebar.dataset.persistentPinned = String(pinned);
	try {
		localStorage.setItem('finra_sidebar_pinned', String(pinned));
	} catch {}
	syncSidebarPinButton(pinned);
}

function hideSidebar(options: { force?: boolean; clearPersistentPin?: boolean } = {}) {
	const { force = false } = options;
	if (!force && (isSidebarTemporarilyPinned() || isSidebarPersistentlyPinned())) return;
	document.getElementById('fg-sidebar')?.classList.add('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
}

function toggleMobileMenu() {
	const sidebar = document.getElementById('fg-sidebar');
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	if (!sidebar) return;
	const isOpen = !sidebar.classList.contains('hidden');
	if (isOpen) {
		hideSidebar({ force: true });
		return;
	}
	sidebar.classList.remove('hidden');
	backdrop?.classList.remove('hidden');
	// Default to collapsed Info chrome (name + Info|Log). Expanding Info loads rich detail.
	const mode = sidebar.dataset.viewMode === 'info' || sidebar.dataset.viewMode === 'log' ? sidebar.dataset.viewMode : 'none';
	sidebar.dataset.viewMode = mode;
	sidebar.dataset.mobileExpanded = mode === 'none' ? 'false' : 'true';
	try {
		window.dispatchEvent(
			new CustomEvent('finra:ensure-sidebar-content', {
				detail: { loadDetails: mode === 'info', reveal: true, viewMode: mode },
			}),
		);
	} catch (e) {
		/* ignore */
	}
}

function handleLegendTooltipBlur(event: React.FocusEvent<HTMLDetailsElement>) {
	const nextTarget = event.relatedTarget;
	if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
	event.currentTarget.open = false;
}

function hideSelectionLog() {
	const panel = document.getElementById('fg-selection-log');
	if (!panel) return;
	const isPinned = panel.dataset.pinned === 'true';
	if (isPinned) return;
	panel.classList.add('hidden');
}

function focusFetchInputWhenEmpty(options: { force?: boolean } = {}) {
	const { force = false } = options;
	const fetchInput = document.getElementById('fg-fetch-input') as HTMLInputElement | null;
	const empty = document.getElementById('fg-empty');
	if (!fetchInput || !empty || fetchInput.disabled || empty.classList.contains('hidden')) return;

	const activeElement = document.activeElement as HTMLElement | null;
	if (!force && activeElement && activeElement !== document.body && activeElement !== fetchInput) {
		return;
	}

	window.requestAnimationFrame(() => {
		if (empty.classList.contains('hidden') || document.activeElement === fetchInput) return;
		fetchInput.focus({ preventScroll: true });
	});
}

function updateNodeRouteHistory(href: string, mode: 'push' | 'replace' = 'push') {
	if (typeof window === 'undefined') return;
	const method = mode === 'replace' ? 'replaceState' : 'pushState';
	window.history[method](window.history.state, '', href);
}

function routeSidebarNodeSelection({
	nodeId,
	browserPathname,
	pathname,
	setBrowserPathname,
	pulseDuration = 5000,
	autoExpand = false,
}: {
	nodeId: string;
	browserPathname: string;
	pathname: string;
	setBrowserPathname: (nextPath: string) => void;
	pulseDuration?: number;
	autoExpand?: boolean;
}) {
	const nextHref = buildNodeRouteHref(nodeId);
	const nextPath = buildNodeRoutePath(nodeId);
	const currentPath = browserPathname || pathname || '/';
	if (nextPath !== currentPath) {
		setBrowserPathname(nextPath);
		updateNodeRouteHistory(nextHref, 'push');
	}
	window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { nodeId, pulseDuration, autoExpand } }));
}

function isFindShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>) {
	return !event.defaultPrevented && !event.altKey && (event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'f';
}

function formatFindCounter(total: number, activeOrdinal = 0) {
	if (!total) return '0 matches';
	if (activeOrdinal > 0) return `${activeOrdinal}/${total}`;
	return `${total} match${total === 1 ? '' : 'es'}`;
}

/** Capability-aware GPU mode: lone dGPU gets full SVG filters; hybrid keeps GPU but strips crashy filters. */
function applySafeGpuMode() {
	if (typeof document === 'undefined' || typeof window === 'undefined') return false;
	const info = probeWebGlGpuInfo();
	const resolved = resolveSafeGpuEnabled({
		renderer: info.renderer,
		vendor: info.vendor,
		probes: info.probes,
		hybrid: info.hybrid,
		search: window.location.search,
		storageGet: (key) => {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		},
	});

	applySafeGpuDomState(resolved.enabled, resolved.tier);

	try {
		// Persist tier so the pre-paint boot script can restore the right mode next load.
		window.localStorage.setItem(GPU_TIER_STORAGE_KEY, resolved.tier);
		if (resolved.preferredRenderer) {
			window.localStorage.setItem(GPU_RENDERER_STORAGE_KEY, resolved.preferredRenderer);
		}
		if (resolved.hybrid) {
			window.localStorage.setItem(HYBRID_GPU_STORAGE_KEY, '1');
		}
	} catch {
		/* ignore quota / private mode */
	}

	if (typeof console !== 'undefined' && console.info) {
		const probeSummary = (info.probes || []).map((probe) => `${probe.powerPreference}:${probe.renderer || 'n/a'}`).join(' | ');
		const onlyIgpu = !resolved.hybrid && resolved.tier === 'integrated' && /hawk.?point|phoenix|rembrandt|radeon\s*780m|radeonsi/i.test(resolved.preferredRenderer || '');
		if (resolved.tier === 'hybrid') {
			console.info(
				`[finra-graph] Hybrid GPU mode. Preferred WebGL: ${resolved.preferredRenderer || 'n/a'}. SVG/backdrop filters stay OFF to avoid Mesa SIGILL — GPU compositing still runs. ?safe_gpu=0 re-enables filters (crash risk). Probes: ${probeSummary || 'none'}`,
			);
		} else if (onlyIgpu) {
			console.info(
				`[finra-graph] WebGL is on the AMD iGPU (${resolved.preferredRenderer}). Filters stay off (SIGILL workaround). To use NVIDIA: launch Chrome with __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia, then reload. Or set localStorage ${HYBRID_GPU_STORAGE_KEY}=1 / ?dgpu=1. Probes: ${probeSummary || 'none'}`,
			);
		} else {
			console.info(
				`[finra-graph] GPU tier=${resolved.tier}; safeEffects=${resolved.enabled ? 'on' : 'off'} (filters off ≠ GPU off). Preferred: ${resolved.preferredRenderer || 'n/a'}. Override with ?safe_gpu=0|1`,
			);
		}
	}
	return resolved.enabled;
}

export default function FinraGraph() {
	const mountedRef = useRef(false);
	const appRef = useRef<HTMLDivElement | null>(null);
	const fetchInputRef = useRef<HTMLInputElement | null>(null);
	const findInputRef = useRef<HTMLInputElement | null>(null);
	const isFindBarOpenRef = useRef(false);

	const wasGraphEmptyRef = useRef<boolean | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	const [graphReady, setGraphReady] = useState(false);
	const [browserPathname, setBrowserPathname] = useState('');
	const [fetchQuery, setFetchQuery] = useState('');
	const [searchType, setSearchType] = useState<'all' | 'people' | 'firms'>('people');
	const [isFindBarOpen, setIsFindBarOpen] = useState(false);
	const [findQuery, setFindQuery] = useState('');
	const [findMatchState, setFindMatchState] = useState({ total: 0, activeOrdinal: 0 });
	const [isSidebarToolsOpen, setIsSidebarToolsOpen] = useState(true);

	useEffect(() => {
		applySafeGpuMode();

		const stored = localStorage.getItem('finra_sidebar_tools_open');
		if (stored !== null) {
			setIsSidebarToolsOpen(stored === 'true');
		}

		// Load persisted search type for the header search control
		try {
			const st = localStorage.getItem('finra_search_type');
			if (st === 'people' || st === 'firms' || st === 'all') setSearchType(st);
		} catch {}
	}, []);

	const toggleSidebarTools = useCallback(() => {
		setIsSidebarToolsOpen((prev) => {
			const newState = !prev;
			localStorage.setItem('finra_sidebar_tools_open', String(newState));
			return newState;
		});
	}, []);
	const [activeFindNodeId, setActiveFindNodeId] = useState<string | null>(null);
	const [focusedFindNodeId, setFocusedFindNodeId] = useState<string | null>(null);
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const routeNodeId = useMemo(() => parseNodeIdFromPathname(browserPathname || pathname), [browserPathname, pathname]);
	const findCounterText = useMemo(() => formatFindCounter(findMatchState.total, findMatchState.activeOrdinal), [findMatchState.activeOrdinal, findMatchState.total]);

	const handleFetchQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		setFetchQuery(event.target.value);
	}, []);

	const isSearchTypeFirstRenderRef = useRef(true);
	useEffect(() => {
		// Skip the mount-time run: the load-from-storage effect above hasn't
		// applied its (possibly different) persisted value to `searchType` yet
		// during this same commit, so writing here would clobber storage with
		// the initial default before the real value ever takes effect.
		if (isSearchTypeFirstRenderRef.current) {
			isSearchTypeFirstRenderRef.current = false;
			return;
		}
		try {
			localStorage.setItem('finra_search_type', searchType);
		} catch {}
	}, [searchType]);

	// Persist sticky query prefs (disable_analytics, safe_gpu) and keep them on the URL
	// across client navigations / refresh — same machine only via localStorage.
	useEffect(() => {
		if (typeof window === 'undefined') return;

		const readPref = (key: string) => {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		};
		const writePref = (key: string, value: string) => {
			try {
				localStorage.setItem(key, value);
			} catch {
				/* ignore */
			}
		};

		const params = new URLSearchParams(window.location.search);
		const urlDisableAnalytics = params.get('disable_analytics') === '1';
		const urlSafeGpu = params.get('safe_gpu') ?? params.get('safeGpu');
		const prefDisableAnalytics = readPref('finra_disable_analytics_pref') === '1';
		const prefSafeGpu = readPref(SAFE_GPU_STORAGE_KEY);

		if (urlDisableAnalytics || prefDisableAnalytics) {
			writePref('finra_disable_analytics_pref', '1');
		}
		if (urlSafeGpu === '0' || urlSafeGpu === '1' || urlSafeGpu === 'true' || urlSafeGpu === 'false') {
			writePref(
				SAFE_GPU_STORAGE_KEY,
				urlSafeGpu === 'true' ? '1'
				: urlSafeGpu === 'false' ? '0'
				: urlSafeGpu,
			);
		}

		const stickyActive = urlDisableAnalytics || prefDisableAnalytics || urlSafeGpu != null || prefSafeGpu === '0' || prefSafeGpu === '1';
		if (!stickyActive) return;

		const buildStickySourceSearch = () => {
			const sticky = new URLSearchParams(window.location.search);
			if (urlDisableAnalytics || prefDisableAnalytics || readPref('finra_disable_analytics_pref') === '1') {
				sticky.set('disable_analytics', '1');
			}
			const safeGpuValue = sticky.get('safe_gpu') ?? sticky.get('safeGpu') ?? readPref(SAFE_GPU_STORAGE_KEY);
			if (safeGpuValue === '0' || safeGpuValue === '1') {
				sticky.set('safe_gpu', safeGpuValue);
				sticky.delete('safeGpu');
			}
			return `?${sticky.toString()}`;
		};

		const addStickyToUrl = (raw: string | null | undefined) => {
			try {
				return applyStickyParamsToUrl(String(raw || window.location.href), buildStickySourceSearch(), window.location.origin);
			} catch {
				return raw || window.location.pathname + window.location.search + window.location.hash;
			}
		};

		const urlNeedsSticky = () => {
			const current = new URLSearchParams(window.location.search);
			if ((urlDisableAnalytics || prefDisableAnalytics || readPref('finra_disable_analytics_pref') === '1') && current.get('disable_analytics') !== '1') {
				return true;
			}
			const desiredSafe = current.get('safe_gpu') ?? readPref(SAFE_GPU_STORAGE_KEY);
			if ((desiredSafe === '0' || desiredSafe === '1') && current.get('safe_gpu') !== desiredSafe) {
				return true;
			}
			return false;
		};

		const origPush = history.pushState;
		const origReplace = history.replaceState;

		history.pushState = function (state: any, title: string, url?: string | null) {
			try {
				const newUrl = url ? addStickyToUrl(url) : url;
				return origPush.apply(this, [state, title, newUrl]);
			} catch {
				return origPush.apply(this, [state, title, url]);
			}
		} as any;
		history.replaceState = function (state: any, title: string, url?: string | null) {
			try {
				const newUrl = url ? addStickyToUrl(url) : addStickyToUrl(window.location.href);
				return origReplace.apply(this, [state, title, newUrl]);
			} catch {
				return origReplace.apply(this, [state, title, url]);
			}
		} as any;

		const onPop = () => {
			try {
				if (urlNeedsSticky()) {
					history.replaceState(history.state, document.title, addStickyToUrl(window.location.href));
				}
			} catch {
				/* ignore */
			}
		};

		window.addEventListener('popstate', onPop);

		if (urlNeedsSticky()) {
			try {
				history.replaceState(history.state, document.title, addStickyToUrl(window.location.href));
			} catch {
				/* ignore */
			}
		}

		return () => {
			try {
				history.pushState = origPush;
				history.replaceState = origReplace;
				window.removeEventListener('popstate', onPop);
			} catch {
				/* ignore */
			}
		};
	}, []);

	const focusFindInput = useCallback(() => {
		window.requestAnimationFrame(() => {
			const input = findInputRef.current;
			if (!input) return;
			input.focus({ preventScroll: true });
			input.select();
		});
	}, []);

	const openFindBar = useCallback(() => {
		setIsFindBarOpen(true);
		focusFindInput();
	}, [focusFindInput]);

	const closeFindBar = useCallback(
		({ clearQuery = false }: { clearQuery?: boolean } = {}) => {
			const input = findInputRef.current;
			if (input && document.activeElement === input) {
				input.blur();
				window.requestAnimationFrame(() => {
					if (appRef.current) {
						appRef.current.focus({ preventScroll: true });
					}
				});
			}
			setIsFindBarOpen(false);
			if (clearQuery) {
				setFindQuery('');
				setFindMatchState({ total: 0, activeOrdinal: 0 });
				setActiveFindNodeId(null);
				setFocusedFindNodeId(null);
				window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: true } }));
				return;
			}
			setFocusedFindNodeId(activeFindNodeId);
			window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: false } }));
		},
		[activeFindNodeId],
	);

	const submitFindQuery = useCallback(() => {
		const query = findQuery.trim();
		if (!query) return;
		const nodeId = focusedFindNodeId || activeFindNodeId;
		if (nodeId) {
			closeFindBar({ clearQuery: false });
			routeSidebarNodeSelection({
				nodeId,
				browserPathname,
				pathname,
				setBrowserPathname,
				pulseDuration: 5000,
				autoExpand: true,
			});
			return;
		}
		window.dispatchEvent(new CustomEvent(FIND_NEXT_EVENT, { detail: { query } }));
	}, [activeFindNodeId, browserPathname, closeFindBar, findQuery, focusedFindNodeId, pathname]);

	const handleFindInputKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				submitFindQuery();

				return;
			}
			if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
				event.preventDefault();

				window.dispatchEvent(
					new CustomEvent(FIND_MOVE_EVENT, {
						detail: {
							direction: event.key,
							query: findQuery.trim(),
						},
					}),
				);
			}
		},
		[findQuery, submitFindQuery],
	);

	const moveFindMatchByButton = useCallback(
		(direction: 'ArrowLeft' | 'ArrowRight') => {
			const query = findQuery.trim();

			if (!query) return;
			window.dispatchEvent(
				new CustomEvent(FIND_MOVE_EVENT, {
					detail: { direction, query },
				}),
			);
		},
		[findQuery],
	);

	useEffect(() => {
		isFindBarOpenRef.current = isFindBarOpen;
	}, [isFindBarOpen]);

	useEffect(() => {
		const input = fetchInputRef.current;
		if (!input) return;

		const syncFetchQuery = () => {
			setFetchQuery(input.value);
		};

		syncFetchQuery();
		input.addEventListener('input', syncFetchQuery);
		return () => {
			input.removeEventListener('input', syncFetchQuery);
		};
	}, [isMounted]);

	// Delegate click handler for CRD links in sidebar
	useEffect(() => {
		if (!isMounted) return;
		const sidebar = document.getElementById('fg-sidebar-inner');
		if (!sidebar) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const nodeBtn = target.closest('[data-node-id]') as HTMLElement | null;
			if (nodeBtn && nodeBtn.dataset.nodeId) {
				e.preventDefault();
				e.stopPropagation();
				routeSidebarNodeSelection({
					nodeId: String(nodeBtn.dataset.nodeId || '').trim(),
					browserPathname,
					pathname,
					setBrowserPathname,
					pulseDuration: 5000,
					autoExpand: true,
				});
				return;
			}

			// CRD-based links (e.g. owner rows, firm/person CRD references) carry data-crd + data-crd-type
			const crdBtn = target.closest('[data-crd]') as HTMLElement | null;
			if (crdBtn && crdBtn.dataset.crd) {
				e.preventDefault();
				e.stopPropagation();
				const crd = String(crdBtn.dataset.crd || '').trim();
				const crdType = String(crdBtn.dataset.crdType || '')
					.trim()
					.toLowerCase();
				const nodeId = crdType === 'person' || crdType === 'individual' ? `person:${crd}` : `firm:${crd}`;
				routeSidebarNodeSelection({
					nodeId,
					browserPathname,
					pathname,
					setBrowserPathname,
					pulseDuration: 5000,
					autoExpand: true,
				});
				return;
			}

			// If the clicked row carries a data-search-query attribute (or a nearby firm span), use that to search-by-name
			const searchBtn = target.closest('[data-search-query]') as HTMLElement | null;
			if (searchBtn) {
				e.preventDefault();
				e.stopPropagation();
				const name = String(searchBtn.dataset.searchQuery || '').trim() || (searchBtn.textContent || '').trim();
				if (name) {
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { searchQuery: name, pulseDuration: 5000 } }));
				}
				return;
			}

			// Fallback: legacy plain firm-name spans
			const firmNameEl = target.closest('.fg-tl-firm') as HTMLElement | null;
			if (firmNameEl) {
				const name = (firmNameEl.textContent || '').trim();
				if (name) {
					e.preventDefault();
					e.stopPropagation();
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { searchQuery: name, pulseDuration: 5000 } }));
				}
			}
		};
		sidebar.addEventListener('click', handler);
		return () => sidebar.removeEventListener('click', handler);
	}, [browserPathname, isMounted, pathname]);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	useEffect(() => {
		if (!isMounted) return;
		// Sync once on mount, then only on browser back/forward (popstate).
		// Do NOT re-run when pathname changes — we control browserPathname
		// directly via setBrowserPathname on node clicks, and re-syncing
		// from window.location would overwrite our pushState-driven value.
		setBrowserPathname(window.location.pathname);
		const syncOnPopState = () => {
			setBrowserPathname(window.location.pathname);
		};
		window.addEventListener('popstate', syncOnPopState);
		return () => {
			window.removeEventListener('popstate', syncOnPopState);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const app = appRef.current;
		const sidebar = document.getElementById('fg-sidebar');
		const empty = document.getElementById('fg-empty');
		if (!app || !sidebar || !empty) return;

		const landscapeMobileQuery = window.matchMedia('(max-width: 860px) and (orientation: landscape)');

		const syncUiFlags = () => {
			const isSidebarOpen = !sidebar.classList.contains('hidden');
			const isGraphEmpty = !empty.classList.contains('hidden');
			const shouldFocusFetchInput = isGraphEmpty && wasGraphEmptyRef.current !== true;
			app.dataset.sidebarOpen = isSidebarOpen ? 'true' : 'false';
			app.dataset.graphEmpty = isGraphEmpty ? 'true' : 'false';
			wasGraphEmptyRef.current = isGraphEmpty;
			if (shouldFocusFetchInput) {
				focusFetchInputWhenEmpty({ force: true });
			}
		};

		syncUiFlags();

		const observer = new MutationObserver(syncUiFlags);
		observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
		observer.observe(empty, { attributes: true, attributeFilter: ['class'] });
		landscapeMobileQuery.addEventListener('change', syncUiFlags);

		return () => {
			observer.disconnect();
			landscapeMobileQuery.removeEventListener('change', syncUiFlags);
		};
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const app = appRef.current;
		const fetchInput = document.getElementById('fg-fetch-input');
		if (!app || !fetchInput) return;

		fetchInput.setAttribute('autocorrect', 'off');
		fetchInput.setAttribute('autocapitalize', 'off');
		fetchInput.setAttribute('data-gramm', 'false');
		(fetchInput as HTMLInputElement).spellcheck = false;

		const syncEmptyStateTarget = () => {
			const rect = fetchInput.getBoundingClientRect();
			app.style.setProperty('--fg-empty-target-center', `${rect.left + rect.width / 2}px`);
			app.style.setProperty('--fg-empty-target-right', `${Math.max(16, window.innerWidth - rect.right)}px`);
			app.style.setProperty('--fg-empty-target-bottom', `${rect.bottom}px`);
		};

		syncEmptyStateTarget();
		window.addEventListener('resize', syncEmptyStateTarget);

		return () => {
			window.removeEventListener('resize', syncEmptyStateTarget);
		};
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted || !graphReady || !isFindBarOpen) return;
		const query = findQuery.trim();
		if (!query) {
			setFindMatchState({ total: 0, activeOrdinal: 0 });
			return;
		}
		window.dispatchEvent(new CustomEvent(FIND_QUERY_EVENT, { detail: { query } }));
	}, [findQuery, graphReady, isFindBarOpen, isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleFindState = (event: Event) => {
			const detail =
				(
					event as CustomEvent<{
						query?: string | null;
						total?: number | null;
						activeOrdinal?: number | null;
						activeNodeId?: string | null;
					}>
				).detail || {};
			setFindMatchState({
				total: Number(detail.total || 0),
				activeOrdinal: Number(detail.activeOrdinal || 0),
			});
			setActiveFindNodeId(detail.activeNodeId || null);
			setFocusedFindNodeId(detail.activeNodeId || null);
		};

		window.addEventListener(FIND_STATE_EVENT, handleFindState as EventListener);
		const handleMobileFindCloseRequest = () => {
			closeFindBar({ clearQuery: false });
		};
		window.addEventListener(MOBILE_FIND_CLOSE_REQUEST_EVENT, handleMobileFindCloseRequest as EventListener);
		return () => {
			window.removeEventListener(FIND_STATE_EVENT, handleFindState as EventListener);
			window.removeEventListener(MOBILE_FIND_CLOSE_REQUEST_EVENT, handleMobileFindCloseRequest as EventListener);
		};
	}, [closeFindBar, isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleDocumentFindShortcut = (event: KeyboardEvent) => {
			if (!isFindShortcut(event)) return;
			event.preventDefault();
			event.stopPropagation();

			const findToggle = document.getElementById('fg-find-toggle') as HTMLButtonElement | null;
			if (findToggle) {
				findToggle.click();
				return;
			}

			setIsFindBarOpen(true);
			focusFindInput();
		};

		document.addEventListener('keydown', handleDocumentFindShortcut);
		return () => {
			document.removeEventListener('keydown', handleDocumentFindShortcut);
		};
	}, [focusFindInput, isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleSearchNavigation = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
			if (isFindBarOpen) return;
			const target = event.target as Element | null;
			if (target?.closest('input,textarea,select') || (target instanceof HTMLElement && target.isContentEditable)) return;
			// Arrow-key canvas focus emits find-state with the focused node as activeNodeId.
			const nodeId = focusedFindNodeId || activeFindNodeId;

			if (event.key === 'Enter' && nodeId) {
				event.preventDefault();
				event.stopPropagation();

				routeSidebarNodeSelection({
					nodeId,
					browserPathname,
					pathname,
					setBrowserPathname,
					autoExpand: true,
				});

				// Ensure selection emphasis is re-applied after keyboard-driven routing
				// (some selection flows can race with other UI updates). Dispatch a
				// lightweight event that the graph runtime listens for to reapply
				// selection state after a short delay.
				if (typeof window !== 'undefined') {
					window.setTimeout(() => {
						try {
							window.dispatchEvent(new Event('finra:reapply-selection'));
						} catch (e) {
							/* ignore */
						}
					}, 80);
				}
				return;
			}

			if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
				event.preventDefault();
				event.stopPropagation();
				window.dispatchEvent(
					new CustomEvent(FIND_MOVE_EVENT, {
						detail: {
							direction: event.key,
							query: findQuery.trim(),
						},
					}),
				);
				return;
			}
		};

		document.addEventListener('keydown', handleSearchNavigation);
		return () => {
			document.removeEventListener('keydown', handleSearchNavigation);
		};
	}, [activeFindNodeId, browserPathname, findQuery, focusedFindNodeId, isFindBarOpen, isMounted, pathname]);

	useEffect(() => {
		if (!isMounted) return;
		// Menu stays open until the hamburger toggle closes it — no outside-click / Escape auto-hide.
		const handleDocumentClickCapture = (event: MouseEvent) => {
			const findBar = document.getElementById('fg-find-header');
			const findToggle = document.getElementById('fg-find-toggle');
			const target = event.target as Node | null;

			if (isFindBarOpenRef.current && findBar && target && !findBar.contains(target) && (!findToggle || !findToggle.contains(target))) {
				closeFindBar({ clearQuery: false });
			}
		};

		const handleDocumentFocusIn = (event: FocusEvent) => {
			const findBar = document.getElementById('fg-find-header');
			const findToggle = document.getElementById('fg-find-toggle');
			const target = event.target as Node | null;
			if (isFindBarOpenRef.current && findBar && target && !findBar.contains(target) && (!findToggle || !findToggle.contains(target))) {
				closeFindBar({ clearQuery: false });
			}
		};

		const handleEscapeKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (isFindBarOpenRef.current) {
				event.preventDefault();
				closeFindBar();
			}
		};
		document.addEventListener('click', handleDocumentClickCapture, true);
		document.addEventListener('focusin', handleDocumentFocusIn, true);
		document.addEventListener('keydown', handleEscapeKey);

		return () => {
			document.removeEventListener('click', handleDocumentClickCapture, true);
			document.removeEventListener('focusin', handleDocumentFocusIn, true);
			document.removeEventListener('keydown', handleEscapeKey);
		};
	}, [closeFindBar, isMounted]);

	useEffect(() => {
		if (!isMounted) return;

		const handleSelectedNodeRoute = (event: Event) => {
			const detail = (event as CustomEvent<{ nodeId?: string | null; replace?: boolean }>).detail || {};
			// null nodeId clears the route to `/` (Clear Highlight / Reset Session).
			const nextHref = buildNodeRouteHref(detail.nodeId ?? null);
			const nextPath = buildNodeRoutePath(detail.nodeId ?? null);
			const currentPath = browserPathname || pathname || '/';
			if (nextPath === currentPath) return;
			setBrowserPathname(nextPath);
			if (detail.replace || !detail.nodeId) {
				updateNodeRouteHistory(nextHref, 'replace');
				return;
			}
			updateNodeRouteHistory(nextHref, 'push');
		};

		window.addEventListener(SELECTED_NODE_ROUTE_EVENT, handleSelectedNodeRoute as EventListener);
		return () => {
			window.removeEventListener(SELECTED_NODE_ROUTE_EVENT, handleSelectedNodeRoute as EventListener);
		};
	}, [browserPathname, isMounted, pathname]);

	useEffect(() => {
		if (!isMounted || !graphReady) return;
		// autoExpand when the routed node is not already selected. Do not forceAutoExpand:
		// click → selectNode already expands, then emits a route change; forcing here ran a
		// second full expand/selection pass and dominated main-thread time on large graphs.
		window.dispatchEvent(
			new CustomEvent(ROUTE_NODE_REQUEST_EVENT, {
				detail: {
					nodeId: routeNodeId,
					autoExpand: true,
					forceAutoExpand: false,
				},
			}),
		);
	}, [graphReady, isMounted, routeNodeId]);

	// Retry fallback disabled: previously this re-dispatched the route-node-request event up
	// to 6 times (every 500ms) whenever the sidebar hadn't yet displayed routeNodeId. For nodes
	// that genuinely can't be resolved (e.g. a firm-connection CRD card pointing at an
	// individual with no cached detail record), this just repeated the same failed lookup and
	// spammed the console with "not found" warnings. The single dispatch above is left in place
	// for the normal case where the graph is still loading.

	useEffect(() => {
		if (!isMounted) return;
		bindTouchDragClickSuppression(document.getElementById('fg-mobile-menu-toggle'));
		bindTouchDragClickSuppression(document.getElementById('fg-sidebar-pin-toggle'));
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted || mountedRef.current) return;
		mountedRef.current = true;

		try {
			const pinned = localStorage.getItem('finra_sidebar_pinned') === 'true';
			if (pinned) {
				const sidebar = document.getElementById('fg-sidebar');
				if (sidebar) sidebar.dataset.persistentPinned = 'true';
				syncSidebarPinButton(true);
			}
		} catch {}

		// Defer heavy graph initialization until after initial paint / idle to improve perceived load
		const startInit = () => {
			Promise.all([import('d3'), import('d3-force'), import('@/lib/finra-graph')]).then(async ([d3Module, d3ForceModule, { init }]) => {
				const combinedD3 = { ...d3Module, ...d3ForceModule };
				(window as any).d3 = combinedD3;
				const defaultSelected = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_DEFAULT_SELECTED) || '';
				// Prefer the dashboard Queue graph sessionStorage bridge (no query string).
				// Keep legacy `?selected=` support for shared links only.
				const bridgePayload = consumeQueueGraphBridgePayload();
				const bridgedSelectedIds = bridgePayload?.nodeIds || [];
				const querySelectedIds = (searchParams.get('selected') || defaultSelected || '')
					.split(',')
					.map((id) => id.trim())
					.filter(Boolean);
				const isolateToSelection = bridgedSelectedIds.length === 0 && searchParams.get('isolate') === '1';
				init(combinedD3, {
					initialRouteNodeId: routeNodeId,
					initialSelectedNodeIds: querySelectedIds,
					initialCanvasNodeIds: bridgedSelectedIds,
					isolateToSelection,
					queueGraphSeed:
						bridgePayload ?
							{
								anchorFirmId: bridgePayload.anchorFirmId,
								anchorFirmName: bridgePayload.anchorFirmName,
								people: bridgePayload.people,
							}
						:	null,
				});
				setGraphReady(true);
			});
		};

		if (typeof (window as any).requestIdleCallback === 'function') {
			(window as any).requestIdleCallback(() => startInit(), { timeout: 2000 });
		} else {
			// fallback: small delay to allow first paint
			setTimeout(() => startInit(), 50);
		}

		return () => {
			import('@/lib/finra-graph').then(({ destroy }) => {
				if (typeof destroy === 'function') destroy();
			});
		};

		// Patch localStorage.setItem once to emit a custom event when selection log changes within same window.
		try {
			if (typeof window !== 'undefined' && !(window as any).__finra_ls_patch_applied) {
				const origSetItem = window.localStorage.setItem.bind(window.localStorage);
				window.localStorage.setItem = function (k, v) {
					origSetItem(k, v);
					try {
						window.dispatchEvent(new CustomEvent('finra:selection-log-changed', { detail: { key: k, value: v } }));
					} catch (e) {
						// ignore
					}
				};
				(window as any).__finra_ls_patch_applied = true;
			}
		} catch (e) {
			// ignore
		}
	}, [isMounted]);

	if (!isMounted) {
		return (
			<div
				id='finra-app'
				className='fg-app-loading'>
				<header className='fg-header'>
					<div className='fg-header-bar'>
						<div className='fg-header-brand'>
							<h1 className='fg-title'>FINRA/SEC</h1>
						</div>
					</div>
				</header>
				<main className='fg-main fg-loading-main'>
					<div className='fg-empty-card'>
						<p className='fg-empty-eyebrow'>Loading graph…</p>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div
			id='finra-app'
			ref={appRef}
			tabIndex={-1}
			data-sidebar-open='false'
			data-sidebar-pinned='false'
			data-legend-open='false'
			data-graph-empty='false'>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<div className='fg-header-brand'>
						<h1 className='fg-title'>FINRA/SEC</h1>
					</div>

					<div
						id='fg-header-controls'
						className='fg-header-controls'>
						<div className='fg-fetch-status'>
							<div className='fg-fetch'>
								<div className='fg-fetch-field'>
									<input
										ref={fetchInputRef}
										id='fg-fetch-input'
										className='fg-fetch-input'
										type='search'
										onChange={handleFetchQueryChange}
										placeholder='name / CRD, or list: mcgee,hopper,musgrove'
										autoComplete='off'
										autoCorrect='off'
										autoCapitalize='off'
										spellCheck={false}
										data-gramm='false'
									/>
									{/* search type selector moved into the Search button to save horizontal space */}
									<div className='fg-toolbar-group fg-toolbar-status fg-toolbar-status--top'>
										<span
											id='fg-subset-info'
											className='fg-subset-info'></span>
										<button
											id='fg-subset-info-pin'
											type='button'
											className='fg-subset-info-pin'
											title='Close status'
											aria-label='Close status'
											aria-pressed='false'>
											<span
												className='fg-subset-info-pin__icon'
												aria-hidden='true'>
												<span className='fg-subset-info-pin__bar fg-subset-info-pin__bar--one' />
												<span className='fg-subset-info-pin__bar fg-subset-info-pin__bar--two' />
											</span>
										</button>
									</div>
								</div>
								<button
									id='fg-database-search'
									className='fg-btn-primary fg-action-btn'
									title='Search all records in the local database'>
									<span className='fg-search-button-content'>
										Search
										<select
											id='fg-search-type'
											className='fg-search-type-inside'
											value={searchType}
											onChange={(e) => setSearchType(e.target.value as any)}
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
						id='fg-focus-readout'
						className='fg-focus-readout'></div>

					{/* <div
						id='fg-hop-controls'
						className='fg-hop-controls'
						style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '0 12px' }}>
						<label style={{ fontSize: '12px', fontWeight: 500 }}>Hops (1-5):</label>
						<div style={{ display: 'flex', gap: '6px' }}>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-expansion-hops'
									defaultValue={String(RUNTIME_EXPANSION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Expansion hops (API initial load)'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(val, cur.click, cur.selection);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Exp</span>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-click-hops'
									defaultValue={String(RUNTIME_CLICK_EXPANSION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Click expansion hops'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(cur.expansion, val, cur.selection);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Click</span>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-selection-hops'
									defaultValue={String(RUNTIME_SELECTION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Selection hops'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(cur.expansion, cur.click, val);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Sel</span>
							</div>
						</div>
					</div> */}

					<div className='fg-header-right-controls'>
						<Link
							href={buildDashboardHrefFromNodeId(routeNodeId) || '/dashboard'}
							className='fg-ghost-btn'
							title='Open dashboard'
							aria-label='Open dashboard'>
							Dash
						</Link>
						<button
							id='fg-mobile-menu-toggle'
							type='button'
							className='fg-mobile-menu-toggle'
							onClick={toggleMobileMenu}
							title='Toggle menu'
							aria-label='Toggle menu'>
							<span
								className='fg-mobile-menu-toggle__icon'
								aria-hidden='true'>
								<span className='fg-mobile-menu-toggle__bar'></span>
								<span className='fg-mobile-menu-toggle__bar'></span>
								<span className='fg-mobile-menu-toggle__bar'></span>
							</span>
						</button>
					</div>
				</div>
			</header>

			<div className='fg-body'>
				<div
					id='fg-find-header'
					className={`fg-find-header${isFindBarOpen ? '' : ' hidden'}`}
					aria-hidden={!isFindBarOpen}
					inert={!isFindBarOpen}>
					<form
						className='fg-find-header__form'
						onSubmit={(event) => {
							event.preventDefault();
							submitFindQuery();
						}}>
						<div className='fg-find-header__field-group'>
							<input
								ref={findInputRef}
								id='fg-find-input'
								className='fg-search-input fg-find-input'
								type='search'
								value={findQuery}
								onChange={(event) => setFindQuery(event.target.value)}
								onKeyDown={handleFindInputKeyDown}
								placeholder='Find in graph…'
								autoComplete='off'
								autoCorrect='off'
								autoCapitalize='off'
								spellCheck={false}
								data-gramm='false'
							/>
							<span
								id='fg-find-counter'
								className='fg-find-counter'
								aria-live='polite'>
								{findCounterText}
							</span>
						</div>
						<div className='fg-find-header__actions'>
							<button
								type='button'
								className='fg-ghost-btn fg-find-arrow'
								onClick={() => moveFindMatchByButton('ArrowLeft')}
								aria-label='Previous match'>
								←
							</button>
							<button
								type='button'
								className='fg-ghost-btn fg-find-arrow'
								onClick={() => moveFindMatchByButton('ArrowRight')}
								aria-label='Next match'>
								→
							</button>
						</div>
					</form>
				</div>

				<div
					id='fg-sidebar-backdrop'
					className='fg-sidebar-backdrop hidden'
					aria-hidden='true'></div>

				{/* Selection log drawer */}
				<aside
					id='fg-selection-log'
					className='fg-selection-log hidden'>
					<div className='fg-log-drawer-header'>
						<h3>Selection Log</h3>
						<div className='fg-log-drawer-actions'>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary'>
								<button
									id='btn-selection-log-copy-all'
									data-fg-selection-log-action='copy-all'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Copy list entries'>
									Copy List
								</button>
								<button
									id='btn-selection-log-toggle-bold'
									data-fg-selection-log-action='toggle-bold'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Make log entries larger and bolder'>
									<strong>Log Bold</strong>
								</button>
							</div>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary'>
								<button
									id='btn-selection-log-clear-ind'
									data-fg-selection-log-action='clear-people'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Clear individual entries from the selection log'>
									Clear Ind
								</button>
								<button
									id='btn-selection-log-clear-firm'
									data-fg-selection-log-action='clear-firms'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Clear firm entries from the selection log'>
									Clear Firm
								</button>
							</div>
							<div
								className='fg-log-drawer-actions-row'
								style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
								<input
									type='text'
									className='fg-selection-log-filter'
									placeholder='Filter log...'
									style={{
										flex: '1',
										padding: '4px 8px',
										border: '1px solid var(--fg-border)',
										borderRadius: '4px',
										background: 'var(--fg-bg-secondary)',
										color: 'var(--fg-text)',
									}}
								/>
								<button
									id='btn-selection-log-edit'
									data-fg-selection-log-action='edit'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Edit selection log entries'>
									Edit
								</button>
							</div>
						</div>
					</div>
					<div
						id='fg-selection-log-list'
						className='fg-selection-log-list'></div>
					<div
						id='fg-selection-log-templates'
						className='fg-selection-log-templates-host'></div>
				</aside>

				{/* Detail sidebar */}
				<aside
					id='fg-sidebar'
					className='fg-sidebar hidden'>
					<div
						className='utility-wrapper'
						style={{ display: 'block', position: 'relative', zIndex: 99, background: 'var(--fg-bg-secondary)', borderBottom: '1px solid var(--fg-border)' }}>
						<div
							className='fg-sidebar-toolbar-header'
							style={{ padding: '8px 8px 0', display: 'flex', gap: '4px', alignItems: 'center', position: 'absolute', right: '1px' }}>
							<button
								type='button'
								className={`fg-sb-toggle-btn ${isSidebarToolsOpen ? 'is-active' : ''}`}
								onClick={toggleSidebarTools}
								title={isSidebarToolsOpen ? 'Hide tools' : 'Show tools'}
								style={{ flex: 1, justifyContent: 'space-between', padding: '5px', background: 'transparent', border: 'none', color: 'inherit' }}>
								<span
									className='fg-sb-toggle-btn__chevron'
									aria-hidden='true'
									style={{ transform: isSidebarToolsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}>
									▾
								</span>
							</button>
						</div>

						{/* <button
							id='fg-sidebar-pin-toggle'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--pin fg-sidebar-action-btn--icon-only'
							type='button'
							onClick={toggleSidebarPin}
							title='Pin panel open'
							aria-label='Pin panel open'
							aria-pressed='false'
							data-pinned='false'
							style={{ background: 'transparent', border: 'none', padding: '6px', color: 'inherit' }}>
							<span
								className='fg-sidebar-action-icon'
								aria-hidden='true'>
								<svg
									viewBox='0 0 16 16'
									fill='none'
									xmlns='http://www.w3.org/2000/svg'>
									<path
										d='M9.5 1.5L14.5 6.5L10.5 10.5L9 9L7 11H5L3 13L3 11L5 9H3L3.5 7L7 7L5.5 5.5L9.5 1.5Z'
										stroke='currentColor'
										strokeWidth='1.2'
										strokeLinejoin='round'
									/>
								</svg>
							</span>
						</button> */}
					</div>
					<div className={`fg-sidebar-toolbar-content ${isSidebarToolsOpen ? '' : 'hidden'}`}>
						<div className='fg-sidebar-actions'></div>
						<div className='fg-sidebar-mobile-actions'>
							<div className='fg-clear-labels-control'>
								<button
									id='btn-sidebar-clear-labels'
									data-fg-selection-log-action='clear-labels-menu'
									className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-clear-labels-control__toggle'
									type='button'
									aria-expanded='false'
									title='Choose whether to clear all large labels or only people labels'
									style={{ width: 'auto', justifyContent: 'center' }}>
									Clear Labels
								</button>
								<div
									className='fg-clear-labels-control__menu'
									role='menu'
									hidden>
									<button
										data-fg-selection-log-action='clear-labels'
										data-fg-clear-labels-scope='all'
										className='fg-ghost-btn fg-btn-sm'
										type='button'
										role='menuitem'
										hidden
										title='Shrink all currently enlarged labels'>
										All labels
									</button>
									<button
										data-fg-selection-log-action='clear-labels'
										data-fg-clear-labels-scope='people'
										className='fg-ghost-btn fg-btn-sm'
										type='button'
										role='menuitem'
										hidden
										title='Shrink only enlarged people labels'>
										People only
									</button>
								</div>
							</div>
							<button
								type='button'
								data-fg-graph-action='select-to-keep'
								className='fg-ghost-btn fg-select-to-keep-btn'
								title='Keep only nodes within the selection circle'>
								Select to keep
							</button>

							<button
								type='button'
								data-fg-action='clear-highlights'
								className='fg-ghost-btn fg-clear-highlights-btn'
								title='Clear hop/line highlights only — selected nodes stay selected'>
								Clear Highlight
							</button>
							<button
								type='button'
								data-fg-graph-action='clear-non-log'
								className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-clear-non-log-btn fg-clear-non-log-btn--stage-1'
								data-clear-non-log-stage='1'
								title='Click 1: keep logged nodes and connecting intermediaries. Click 2: also strip previous-employment lines and clear highlights.'>
								<span className='fg-sidebar-action-label'>Clear non-log</span>
							</button>
							<button
								type='button'
								data-fg-selection-log-action='toggle-bold'
								className='fg-ghost-btn'
								title='Make log entries larger and bolder'>
								Log Bold
							</button>
							<button
								type='button'
								data-fg-action='clear-session'
								className='fg-danger-btn'
								title='Clear saved session and reload fresh'>
								Reset Session
							</button>
						</div>
					</div>
					<div
						id='fg-sidebar-inner'
						className='fg-sidebar-inner'>
						{/* <p className='fg-hint'>Click a node to inspect it.</p> */}
					</div>
					{/* Keep above .fg-sidebar-inner so focus/refresh icons stay clickable. */}
					<div className='fg-sidebar-theme-stack'>
						<ThemeToggle />
						<button
							id='fg-focus-btn'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-sidebar-action-btn--icon-only fg-sidebar-focus-btn'
							type='button'
							title='Focus on this node'
							aria-label='Center on this node'>
							<span
								className='fg-sidebar-action-icon'
								aria-hidden='true'>
								<svg
									viewBox='0 0 16 16'
									fill='none'
									focusable='false'>
									<circle
										cx='8'
										cy='8'
										r='2.75'
										stroke='currentColor'
										strokeWidth='1.4'
									/>
									<path
										d='M8 1.75V4'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M8 12V14.25'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M1.75 8H4'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M12 8H14.25'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
								</svg>
							</span>
						</button>
						<button
							type='button'
							data-fg-action='refresh-layout'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-sidebar-action-btn--icon-only fg-sidebar-refresh-btn'
							title='Re-run the graph layout'
							aria-label='Reflow layout'>
							<span
								className='fg-sidebar-action-icon'
								aria-hidden='true'>
								↺
							</span>
						</button>
					</div>
				</aside>

				<main
					className='fg-main'
					id='fg-main'>
					<canvas
						id='fg-canvas'
						style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'auto' }}></canvas>
					<div
						id='fg-legend'
						className='fg-legend'></div>
					<div
						id='fg-empty'
						className='fg-empty hidden'>
						<div
							id='fg-session-prompt'
							className='fg-empty-card fg-session-restore-card hidden'
							style={{ textAlign: 'center', maxWidth: '420px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
							<h3
								id='fg-session-prompt-title'
								style={{ margin: 0, color: 'var(--text-h, var(--text))' }}>
								Resume previous session?
							</h3>
							<p
								id='fg-session-prompt-body'
								style={{ margin: 0, color: 'var(--text-muted, var(--text-m))', fontSize: '13px' }}>
								You have a saved graph from a previous visit. Continue with the full canvas, load selection-log CRDs only, or reset.
							</p>
							<div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
								<button
									id='fg-btn-resume-session'
									className='fg-sidebar-action-btn fg-sidebar-action-btn--primary'
									style={{ width: '100%', padding: '8px 16px', height: 'auto' }}>
									Continue
								</button>
								<button
									id='fg-btn-loglist-session'
									className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
									style={{ width: '100%', padding: '8px 16px', height: 'auto', border: '1px solid var(--border)' }}>
									Load log-list only
								</button>
								<button
									id='fg-btn-reset-session'
									className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
									style={{ width: '100%', padding: '8px 16px', height: 'auto', border: '1px solid var(--border)' }}>
									Reset content
								</button>
							</div>
						</div>
						<div
							id='fg-session-loader'
							className='fg-empty-card fg-session-restore-card hidden'
							style={{ textAlign: 'center', maxWidth: '300px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
							<h3 style={{ margin: 0, color: 'var(--text-h, var(--text))' }}>Restoring previous session…</h3>
							<p style={{ margin: 0, color: 'var(--text-muted, var(--text-m))', fontSize: '13px' }}>Loading your saved graph. You can keep working once nodes appear.</p>
						</div>
						<div
							id='fg-empty-default'
							className='fg-empty-card'>
							<div
								className='fg-empty-card__arrow'
								aria-hidden='true'>
								<span className='fg-empty-card__arrow-line'></span>
								<span className='fg-empty-card__arrow-head'></span>
							</div>
							<h4 className='fg-empty-title'>Fetch nodes with the search field above.</h4>
							<ul className='fg-empty-steps'>
								<li>
									Selecting Firm nodes reveal it's BD/Control Positions (red). Full firm connection list can be seen within the dashboard, selected CRDs are added to the Queue
									Graph list which will then be fetched onto the node graph when returning.
								</li>
								<li>Selecting Individual nodes reveal it's current and previous employment connections (blue).</li>
							</ul>
							<br />
							<a
								href='https://github.com/tvv1001'
								target='_blank'
								rel='noopener noreferrer'>
								GitHub Repository -- https://github.com/tvv1001
							</a>
						</div>
					</div>
				</main>
			</div>

			<div
				id='fg-log-panel'
				className='fg-log-panel hidden'>
				<div className='fg-log-header'>
					<span>Scraper Output</span>
					<button
						id='btn-log-close'
						className='fg-log-close'>
						✕
					</button>
				</div>
				<pre
					id='fg-log-body'
					className='fg-log-body'></pre>
			</div>
		</div>
	);
}

// Export helpers for unit testing (DOM-only, no browser binaries required)
export {
	bindTouchDragClickSuppression,
	ensureSidebarHintContent,
	isFindShortcut,
	isSidebarTemporarilyPinned,
	isSidebarPersistentlyPinned,
	syncSidebarPinButton,
	toggleSidebarPin,
	hideSidebar,
	toggleMobileMenu,
	handleLegendTooltipBlur,
	hideSelectionLog,
	focusFetchInputWhenEmpty,
	routeSidebarNodeSelection,
	formatFindCounter,
};
