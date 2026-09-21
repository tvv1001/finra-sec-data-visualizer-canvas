/* HTML overlay for labels and tooltips synced to Pixi/WebGL transform.
 * Keeps a lightweight set of absolutely positioned <div> labels that follow
 * world coordinates by applying the same d3 zoom transform used by the renderer.
 */

import { DEFAULT_NODE_LABEL_FONT_SIZE, DEFAULT_NODE_LABEL_FONT_SIZE_PX, DEFAULT_NODE_LABEL_FONT_WEIGHT, DEFAULT_NODE_LABEL_GAP_PX } from './finra-graph-defaults';
import { handleNodeKeyboardActivation } from './finra-graph';
import { buildNodeRoutePath } from './node-route';
type Node = any;

function getNodeVisualHalf(node: Node) {
	if (typeof node?._vizHalf === 'number' && Number.isFinite(node._vizHalf)) return node._vizHalf;
	if (node?.group === 'firm') return 10;
	if (node?.group === 'entity') return 10.5;
	return 7;
}

let container: HTMLElement | null = null;
let parentEl: HTMLElement | null = null;
let dpr = 1;
const detailCache = new Map<string, any>();
let hoverTimerGlobal: number | null = null;
let activeTooltipIdGlobal: string | null = null;
const OVERLAY_LABEL_ZOOM_THRESHOLD = 1.4;
const MAX_OVERLAY_LABELS = 100;

function worldToScreen(x: number, y: number, transform: { x: number; y: number; k: number }) {
	return { x: transform.x + x * transform.k, y: transform.y + y * transform.k };
}

export function createOverlay(
	parent: HTMLElement,
	opts: { onClick?: (node: any) => void; onHover?: (node: any) => void; onHoverEnd?: () => void; onFocus?: (node: any) => void; onBlur?: () => void } = {},
) {
	destroyOverlay();
	parentEl = parent;
	const { onClick, onHover, onHoverEnd, onFocus, onBlur } = opts || {};
	container = document.createElement('div');
	container.id = 'fg-overlay';
	container.style.position = 'absolute';
	container.style.left = '0';
	container.style.top = '0';
	container.style.width = '100%';
	container.style.height = '100%';
	container.style.pointerEvents = 'none';
	container.style.zIndex = '2';
	parent.style.position = parent.style.position || 'relative';
	parent.appendChild(container);
	dpr = Math.max(1, window.devicePixelRatio || 1);
	window.addEventListener('resize', resize);
	resize();

	// delegated click handler
	container.addEventListener('click', (ev) => {
		const el = (ev.target as HTMLElement).closest('.fg-overlay-label') as HTMLElement | null;
		if (!el) return;
		const id = el.dataset.nodeId;
		if (!id) return;
		const node = (el as any).__node;
		if (typeof onClick === 'function') {
			try {
				onClick(node);
			} catch (e) {}
		} else {
			try {
				container?.dispatchEvent(new CustomEvent('finra:overlay-click', { detail: { id } }));
			} catch (e) {}
		}
		// also notify global listeners (window) so graph can react when overlay
		// labels (HTML) intercept pointer events above the SVG canvas
		try {
			if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('finra:overlay-click', { detail: { id } }));
		} catch (e) {}
	});

	// hover with debounce, show tooltip and dispatch hover
	container.addEventListener('mouseover', (ev) => {
		const el = (ev.target as HTMLElement).closest('.fg-overlay-label') as HTMLElement | null;
		if (!el) return;
		const node = (el as any).__node;
		if (hoverTimerGlobal) {
			clearTimeout(hoverTimerGlobal);
			hoverTimerGlobal = null;
		}
		hoverTimerGlobal = window.setTimeout(() => {
			activeTooltipIdGlobal = el.dataset.nodeId || null;
			if (typeof onHover === 'function') {
				try {
					onHover(node);
				} catch (e) {}
			} else {
				try {
					container?.dispatchEvent(new CustomEvent('finra:overlay-hover', { detail: { id: el.dataset.nodeId } }));
				} catch (e) {}
			}
			// also notify global listeners so graph hover state can update when
			// pointer is over an overlay label (which sits above the canvas)
			try {
				if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('finra:overlay-hover', { detail: { id: el.dataset.nodeId } }));
			} catch (e) {}
			showTooltipForNode(node, el, detailCache);
		}, 120);
	});

	container.addEventListener('mouseout', (ev) => {
		if (hoverTimerGlobal) {
			clearTimeout(hoverTimerGlobal);
			hoverTimerGlobal = null;
		}
		const related = ev.relatedTarget as HTMLElement | null;
		const toLabel = related?.closest('.fg-overlay-label');
		if (!toLabel) {
			if (typeof onHoverEnd === 'function') {
				try {
					onHoverEnd();
				} catch (e) {}
			}
			// notify global listeners that hover ended (so graph can clear hover)
			try {
				if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('finra:overlay-hover-end'));
			} catch (e) {}
		}
		window.setTimeout(() => {
			if (!activeTooltipIdGlobal) return;
			const tooltip = document.getElementById('fg-overlay-tooltip');
			if (tooltip && tooltip.contains(document.activeElement)) return;
			hideTooltip();
			activeTooltipIdGlobal = null;
		}, 150);
	});

	// delegated focus/blur handler in overlay
	container.addEventListener('focusin', (ev) => {
		const el = (ev.target as HTMLElement).closest('.fg-overlay-label') as HTMLElement | null;
		if (!el) return;
		const node = (el as any).__node;
		if (typeof onFocus === 'function') {
			try {
				onFocus(node);
			} catch (e) {}
		}
	});

	container.addEventListener('focusout', (ev) => {
		const related = ev.relatedTarget as HTMLElement | null;
		const toLabel = related?.closest('.fg-overlay-label');
		if (!toLabel) {
			if (typeof onBlur === 'function') {
				try {
					onBlur();
				} catch (e) {}
			}
		}
	});

	// keyboard navigation
	container.addEventListener('keydown', (ev) => {
		const el = (ev.target as HTMLElement).closest('.fg-overlay-label') as HTMLElement | null;
		if (!el) return;
		if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
			ev.preventDefault();
			focusNextLabel(el, 1);
		} else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			focusNextLabel(el, -1);
		}
	});

	return { update: updateOverlay, resize, destroy: destroyOverlay };
}

export function destroyOverlay() {
	if (container && container.parentElement) container.parentElement.removeChild(container);
	if (window && typeof window !== 'undefined') window.removeEventListener('resize', resize);
	container = null;
	parentEl = null;
}

function resize() {
	if (!container || !parentEl) return;
	const rect = parentEl.getBoundingClientRect();
	container.style.width = `${Math.max(1, Math.floor(rect.width))}px`;
	container.style.height = `${Math.max(1, Math.floor(rect.height))}px`;
}

function createLabelElement(node: Node) {
	const el = document.createElement('div');
	el.className = 'fg-overlay-label';
	el.style.position = 'absolute';
	el.style.transform = 'translate(-50%, 0)';
	el.style.pointerEvents = 'auto';
	el.style.padding = '4px 8px';
	el.style.borderRadius = '4px';
	el.style.background = 'rgba(255,255,255,0.95)';
	el.style.boxShadow = '0 2px 6px rgba(16,24,40,0.12)';
	el.style.fontSize = DEFAULT_NODE_LABEL_FONT_SIZE;
	el.style.fontWeight = DEFAULT_NODE_LABEL_FONT_WEIGHT;
	el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--color-default-text') || '#0f172a';
	el.textContent = node.label || node.name || String(node.id);
	el.setAttribute('tabindex', '0');
	// store node reference for event handlers
	(el as any).__node = node;
	el.dataset.nodeId = String(node.id);
	// keyboard activation (Enter/Space)
	el.addEventListener('keydown', (ev) => {
		if (handleNodeKeyboardActivation(ev, node)) {
			try {
				el.click();
			} catch (e) {}
		}
	});
	return el;
}

export function updateOverlay(
	nodes: Node[],
	transform: { x: number; y: number; k: number },
	opts: { selectedId?: string | number; labelScale?: number; logLabelNodeIds?: Array<string | number> } = {},
) {
	if (!container || !parentEl) return;
	// Only show overlay labels once the user is zoomed in enough.
	const rect = parentEl.getBoundingClientRect();
	const w = rect.width,
		h = rect.height;
	const scale = transform.k || 1;
	const invK = 1 / (transform.k || 1);
	const minX = -transform.x * invK - 40;
	const minY = -transform.y * invK - 40;
	const maxX = (-transform.x + w) * invK + 40;
	const maxY = (-transform.y + h) * invK + 40;

	// compute visible nodes
	const visible = (nodes || []).filter((n) => n && Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY);

	// choose nodes to label only when zoomed in enough
	const toLabel: Node[] = [];
	const forcedLabelIds = new Set((opts.logLabelNodeIds || []).map((id) => String(id)));
	if (forcedLabelIds.size) {
		visible.forEach((node) => {
			if (forcedLabelIds.has(String(node.id))) toLabel.push(node);
		});
	}
	if (scale >= OVERLAY_LABEL_ZOOM_THRESHOLD) {
		if (opts.selectedId) {
			const sel = visible.find((n) => String(n.id) === String(opts.selectedId));
			if (sel) toLabel.push(sel);
		}
		// sort by degree-ish if present, else leave order
		const withDegree = visible.map((n) => {
			let deg = 0;
			if (typeof n.degree === 'number') deg = n.degree;
			else if (n._deg && typeof n._deg.total === 'number') deg = n._deg.total;
			else if (typeof n._deg === 'number') deg = n._deg;
			return { n, deg };
		});
		withDegree.sort((a, b) => b.deg - a.deg);
		for (const item of withDegree.slice(0, MAX_OVERLAY_LABELS)) {
			if (!toLabel.find((x) => String(x.id) === String(item.n.id))) toLabel.push(item.n);
		}
	}

	// Reuse existing elements where possible by id
	const existing = new Map<string, HTMLElement>();
	container.querySelectorAll<HTMLElement>('.fg-overlay-label').forEach((el) => {
		const id = el.dataset.nodeId;
		if (id) existing.set(id, el);
	});

	const keep = new Set<string>();
	for (const n of toLabel) {
		const id = String(n.id);
		keep.add(id);
		let el = existing.get(id);
		if (!el) {
			el = createLabelElement(n);
			// ensure dataset is present
			el.dataset.nodeId = id;
			container.appendChild(el);
		}
		const p = worldToScreen(n.x, n.y, transform);
		const visualHalf = getNodeVisualHalf(n) * Math.max(0.1, transform.k || 1);
		const isFocusedLabel = Boolean(opts.selectedId && String(opts.selectedId) === String(n.id)) || forcedLabelIds.has(String(n.id));
		const effectiveLabelScale = isFocusedLabel ? Math.max(1, Number(opts.labelScale) || 1) : 1;
		el.style.left = `${Math.round(p.x)}px`;
		el.style.top = `${Math.round(p.y + visualHalf + DEFAULT_NODE_LABEL_GAP_PX)}px`;
		el.style.fontSize = `${Math.max(DEFAULT_NODE_LABEL_FONT_SIZE_PX, Math.round(DEFAULT_NODE_LABEL_FONT_SIZE_PX * effectiveLabelScale * 10) / 10)}px`;
	}

	// remove leftover labels
	for (const [id, el] of existing) {
		if (!keep.has(id)) el.remove();
	}
}

export function overlayResize() {
	resize();
}

function focusNextLabel(currentEl: HTMLElement, delta: number) {
	const labels = Array.from(document.querySelectorAll<HTMLElement>('#fg-overlay .fg-overlay-label'));
	const idx = labels.indexOf(currentEl);
	if (idx === -1) return;
	const next = labels[(idx + delta + labels.length) % labels.length];
	if (next) next.focus();
}

function showTooltipForNode(node: any, anchorEl: HTMLElement, cache: Map<string, any>) {
	if (!container) return;
	const id = String(node.id);
	const existing = document.getElementById('fg-overlay-tooltip');
	if (existing) existing.remove();
	const tip = document.createElement('div');
	tip.id = 'fg-overlay-tooltip';
	tip.style.position = 'absolute';
	tip.style.pointerEvents = 'auto';
	tip.style.zIndex = '3';
	tip.style.background = 'white';
	tip.style.padding = '8px 10px';
	tip.style.borderRadius = '6px';
	tip.style.boxShadow = '0 6px 20px rgba(2,6,23,0.16)';
	tip.style.fontSize = '13px';
	tip.style.color = getComputedStyle(document.documentElement).getPropertyValue('--color-default-text') || '#0f172a';
	tip.tabIndex = -1;
	tip.textContent = 'Loading...';
	container.appendChild(tip);

	// position near anchor
	const rect = anchorEl.getBoundingClientRect();
	const parentRect = container.getBoundingClientRect();
	tip.style.left = `${Math.round(rect.left - parentRect.left)}px`;
	tip.style.top = `${Math.round(rect.top - parentRect.top - rect.height - 8)}px`;

	// fetch details (use nodes-by-ids endpoint)
	if (cache.has(id)) {
		renderTooltipContent(tip, cache.get(id));
		return;
	}
	fetch(`/api/finra/nodes-by-ids?ids=${encodeURIComponent(id)}`)
		.then((r) => (r.ok ? r.json() : null))
		.then((data) => {
			const nodeData = Array.isArray(data) && data.length ? data[0] : null;
			cache.set(id, nodeData || {});
			renderTooltipContent(tip, nodeData || {});
		})
		.catch((err) => {
			tip.textContent = 'Details unavailable';
			console.warn('Tooltip fetch failed', err);
		});
}

function renderTooltipContent(tip: HTMLElement, nodeData: any) {
	tip.innerHTML = '';
	const title = document.createElement('div');
	title.style.fontWeight = '600';
	title.style.marginBottom = '6px';
	title.textContent = nodeData?.label || nodeData?.name || String(nodeData?.id || '');
	tip.appendChild(title);
	const meta = document.createElement('div');
	meta.style.fontSize = '12px';
	meta.style.opacity = '0.9';
	meta.textContent = nodeData?.summary || nodeData?.subtitle || '';
	tip.appendChild(meta);
	const link = document.createElement('a');
	link.href = buildNodeRoutePath(String(nodeData?.id || ''));
	link.textContent = 'View profile';
	link.style.display = 'block';
	link.style.marginTop = '8px';
	tip.appendChild(link);
}

function hideTooltip() {
	const existing = document.getElementById('fg-overlay-tooltip');
	if (existing) existing.remove();
}
