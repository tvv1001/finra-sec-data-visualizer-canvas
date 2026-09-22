/* Lightweight Canvas renderer for finra graph — viewport-culling, LOD, and fast draw
 * This is a minimal, dependency-free fallback that draws nodes/links to a canvas
 * overlay and is intended for large graphs where SVG DOM painting becomes too slow.
 */

import { DEFAULT_NODE_LABEL_FONT_SIZE_PX, DEFAULT_NODE_LABEL_FONT_WEIGHT, DEFAULT_NODE_LABEL_GAP_PX } from './finra-graph-defaults';

type Node = any;
type Link = any;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let parentEl: HTMLElement | null = null;
let dpr = 1;
let currentNodes: Node[] = [];
let currentLinks: Link[] = [];
let currentOpts: any = {};
let currentTransform = { x: 0, y: 0, k: 1 };
let hoverNodeId: string | null = null;

function getHitNode(clientX: number, clientY: number) {
	if (!canvas) return null;
	const rect = canvas.getBoundingClientRect();
	const x = clientX - rect.left;
	const y = clientY - rect.top;

	const invK = 1 / (currentTransform.k || 1);
	const wx = (x - currentTransform.x) * invK;
	const wy = (y - currentTransform.y) * invK;

	let bestNode = null;
	let bestDist = Infinity;

	for (const n of currentNodes) {
		const dx = n.x - wx;
		const dy = n.y - wy;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const vizHalf = (n && n._vizHalf) || (n.group === 'firm' ? 6 : 4);
		const size = Math.max(1, vizHalf * (currentTransform.k < 0.5 ? 0.6 : currentTransform.k < 1 ? 0.9 : 1.2));

		if (dist <= size + 4 * invK) {
			if (dist < bestDist) {
				bestDist = dist;
				bestNode = n;
			}
		}
	}
	return bestNode;
}

function onCanvasClick(e: MouseEvent) {
	const hit = getHitNode(e.clientX, e.clientY);
	if (hit && onNodeClickCallback) {
		onNodeClickCallback(e, hit);
	}
}

function onCanvasPointerMove(e: PointerEvent) {
	const hit = getHitNode(e.clientX, e.clientY);
	const newHover = hit ? String(hit.id) : null;
	if (hoverNodeId !== newHover) {
		hoverNodeId = newHover;
		if (canvas) {
			canvas.style.cursor = hit ? 'pointer' : 'default';
		}
		drawCanvasFrame(currentNodes, currentLinks, currentTransform, currentOpts);
	}
}


export function createCanvasOverlay(parent: HTMLElement) {
	cachedThemeColors = null;
	destroyCanvas();
	parentEl = parent;
	canvas = document.createElement('canvas');
	canvas.id = 'fg-canvas';
	canvas.style.position = 'absolute';
	canvas.style.left = '0';
	canvas.style.top = '0';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	canvas.style.zIndex = '1';
	canvas.style.pointerEvents = 'auto';
	parent.style.position = parent.style.position || 'relative';
	parent.appendChild(canvas);
	ctx = canvas.getContext('2d');
	dpr = Math.max(1, window.devicePixelRatio || 1);
	resize();
	window.addEventListener('resize', resize);
	canvas.addEventListener('click', onCanvasClick);
	canvas.addEventListener('pointermove', onCanvasPointerMove);
	return { drawFrame: drawCanvasFrame, resize, destroy: destroyCanvas };
}

export function destroyCanvas() {
	if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
	if (window && typeof window !== 'undefined') window.removeEventListener('resize', resize);
	if (canvas) {
		canvas.removeEventListener('click', onCanvasClick);
		canvas.removeEventListener('pointermove', onCanvasPointerMove);
	}
	canvas = null;
	ctx = null;
	parentEl = null;
}

function resize() {
	if (!canvas || !parentEl || !ctx) return;
	const rect = parentEl.getBoundingClientRect();
	const w = Math.max(1, Math.floor(rect.width));
	const h = Math.max(1, Math.floor(rect.height));
	canvas.width = Math.floor(w * dpr);
	canvas.height = Math.floor(h * dpr);
	canvas.style.width = `${w}px`;
	canvas.style.height = `${h}px`;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function worldToScreen(x: number, y: number, transform: { x: number; y: number; k: number }) {
	return { x: transform.x + x * transform.k, y: transform.y + y * transform.k };
}

function endpointNode(endpoint: Node) {
	return endpoint && typeof endpoint === 'object' ? endpoint : currentNodes.find((node) => String(node.id) === String(endpoint));
}

function isControlLink(link: Link) {
	return ['controls', 'controlled_by', 'owner', 'officer', 'associated_with'].includes(String(link?.relationship || '').toLowerCase());
}

function isPreviousLink(link: Link) {
	const relationship = String(link?.relationship || '').toLowerCase();
	return (
		link?.forceGray === true ||
		link?.isForcedGray === true ||
		link?.isCurrent === false ||
		relationship === 'previous_employed_by' ||
		relationship === 'previous_registered_by' ||
		Boolean(link?.endDate)
	);
}

function isInactiveNode(node: Node) {
	if (!node) return false;
	if (node.inactive === true || node.isInactive === true) return true;
	const status = String(node.status || node.firmStatus || node.bcScope || node.iaScope || '').toLowerCase();
	return ['inactive', 'terminated', 'withdrawn', 'not active'].includes(status);
}

function drawNode(ctx: CanvasRenderingContext2D, n: Node, transform: any, size = 4, color = '#888', stroke = '#fff', strokeWidth = 1) {
	const p = worldToScreen(n.x, n.y, transform);
	const radius = Math.max(1, size * transform.k);
	ctx.beginPath();
	if (n.group === 'firm') {
		for (let i = 0; i < 6; i += 1) {
			const angle = Math.PI / 3 * i - Math.PI / 6;
			const x = p.x + radius * Math.cos(angle);
			const y = p.y + radius * Math.sin(angle);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
	} else if (n.group === 'entity') {
		ctx.moveTo(p.x, p.y - radius * 1.5);
		ctx.lineTo(p.x + radius * 1.5, p.y);
		ctx.lineTo(p.x, p.y + radius * 1.5);
		ctx.lineTo(p.x - radius * 1.5, p.y);
		ctx.closePath();
	} else {
		ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
	}
	ctx.fillStyle = color;
	ctx.fill();
	ctx.strokeStyle = stroke;
	ctx.lineWidth = strokeWidth * Math.max(0.65, transform.k);
	ctx.stroke();
}

let cachedThemeColors: Record<string, string> | null = null;

function resolveCachedThemeColors() {
	if (cachedThemeColors) return cachedThemeColors;
	const root = document.documentElement;
	const computed = window.getComputedStyle(root);
	cachedThemeColors = {
		individual: computed.getPropertyValue('--color-highlight-individual').trim() || '#0ea5a4',
		stub: computed.getPropertyValue('--color-node-stub').trim() || '#8ab7ee',
		firm: computed.getPropertyValue('--color-highlight-firm').trim() || '#7c3aed',
		entity: computed.getPropertyValue('--color-highlight-entity').trim() || '#fb923c',
		defaultText: computed.getPropertyValue('--color-default-text').trim() || '#94a3b8',
		defaultLine: computed.getPropertyValue('--color-default-line').trim() || 'rgba(100, 116, 139, 0.72)',
		employed: computed.getPropertyValue('--color-highlight-employed').trim() || '#1a7af0',
		controls: computed.getPropertyValue('--color-highlight-controls').trim() || '#ef4444',
		inactive: computed.getPropertyValue('--color-node-inactive').trim() || '#869ab944',
		inactiveStroke: computed.getPropertyValue('--color-node-inactive-stroke').trim() || '#94a3b899',
		inactiveLabel: computed.getPropertyValue('--color-node-inactive-label').trim() || '#334155',
		border: computed.getPropertyValue('--color-node-border').trim() || '#ffffff',
	};
	return cachedThemeColors;
}

function getColorForGroup(g: string) {
	const colors = resolveCachedThemeColors();
	if (g === 'individual') return colors.individual;
	if (g === 'firm') return colors.firm;
	if (g === 'entity') return colors.entity;
	return colors.defaultText;
}

function getLinkStyle(link: Link, selectedId: string | number | undefined) {
	const colors = resolveCachedThemeColors();
	const source = endpointNode(link?.source);
	const target = endpointNode(link?.target);
	const inactive = isInactiveNode(source) || isInactiveNode(target);
	const previous = isPreviousLink(link);
	const control = isControlLink(link);
	const selected = selectedId != null && (String(source?.id) === String(selectedId) || String(target?.id) === String(selectedId));
	return {
		color: inactive || previous ? colors.inactiveStroke : control ? colors.controls : colors.employed,
		width: control ? 2.35 : previous || inactive ? 1.65 : 1.95,
		opacity: selected ? 1 : inactive ? 0.92 : control ? 1 : previous ? 0.92 : 0.98,
		dash: previous || inactive ? [2, 3] : [],
	};
}

// Margin in world units to draw slightly outside viewport for smooth panning
const VIEWPORT_MARGIN = 60;

export function drawCanvasFrame(
	nodes: Node[],
	links: Link[],
	transform: { x: number; y: number; k: number },
	opts: { selectedId?: string | number; labelScale?: number; logLabelNodeIds?: Array<string | number> } = {},
) {
	currentNodes = nodes;
	currentLinks = links;
	currentOpts = opts;
	currentTransform = transform;
	if (!canvas || !ctx || !parentEl) return;
	const rect = parentEl.getBoundingClientRect();
	const w = rect.width;
	const h = rect.height;
	// clear canvas
	ctx.clearRect(0, 0, w, h);

	// compute world bounds that map to viewport
	const invK = 1 / (transform.k || 1);
	const minX = -transform.x * invK - VIEWPORT_MARGIN;
	const minY = -transform.y * invK - VIEWPORT_MARGIN;
	const maxX = (-transform.x + w) * invK + VIEWPORT_MARGIN;
	const maxY = (-transform.y + h) * invK + VIEWPORT_MARGIN;

	// cull nodes
	const visibleNodes = nodes.filter((n) => n && Number.isFinite(n.x) && Number.isFinite(n.y) && n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY);

	// Draw links in the same role-specific palette as the SVG renderer.
	for (const l of links) {
		const a = l.source;
		const b = l.target;
		if (!a || !b) continue;
		// cheap bbox test
		if (a.x < minX && b.x < minX) continue;
		if (a.x > maxX && b.x > maxX) continue;
		if (a.y < minY && b.y < minY) continue;
		if (a.y > maxY && b.y > maxY) continue;
		const sa = worldToScreen(a.x, a.y, transform);
		const sb = worldToScreen(b.x, b.y, transform);
		const style = getLinkStyle(l, opts.selectedId);
		ctx.beginPath();
		ctx.setLineDash(style.dash);
		ctx.lineWidth = style.width * Math.max(0.55, Math.min(2.15, 1 / Math.max(0.35, transform.k)));
		ctx.strokeStyle = style.color;
		ctx.globalAlpha = style.opacity;
		ctx.moveTo(sa.x, sa.y);
		ctx.lineTo(sb.x, sb.y);
		ctx.stroke();
	}
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;

	// node LOD: if zoomed out, draw small dots; zoomed in show larger and highlight selected
	const scale = transform.k || 1;
	const globalCanvasLabelZoomThreshold = 2.4;
	const selectedCanvasLabelZoomThreshold = 1.4;
	const forcedLabelIds = new Set((opts.logLabelNodeIds || []).map((id) => String(id)));

	for (const n of visibleNodes) {
		const colors = resolveCachedThemeColors();
		const inactive = isInactiveNode(n);
		const col = inactive ? colors.inactive : n.group === 'individual' && n.stub ? colors.stub : getColorForGroup(n.group);
		// Prefer any precomputed viz half-radius (from D3 renderer); otherwise
		// fall back to defaults. _vizHalf stores a half-radius used by SVG, so
		// use it directly for canvas sizing when available.
		const vizHalf = (n && n._vizHalf) || (n.group === 'firm' ? 6 : 4);
		const size = Math.max(
			1,
			vizHalf *
				(scale < 0.5 ? 0.6
				: scale < 1 ? 0.9
				: 1.2),
		);
		const isSelected = opts.selectedId && String(opts.selectedId) === String(n.id);
		const isHovered = hoverNodeId === String(n.id);
		const isForcedLabel = forcedLabelIds.has(String(n.id));
		const nodeStroke = inactive ? colors.inactiveStroke : isSelected ? '#16053f' : colors.border;
		const nodeStrokeWidth = isSelected ? (n.group === 'firm' ? 3.4 : 3.2) : n.group === 'firm' ? 0.9 : 1.5;
		const shouldShowLabel = isForcedLabel || isSelected || scale >= globalCanvasLabelZoomThreshold;
		const focusLabelScale = isSelected || isForcedLabel ? Math.max(1, Number(opts.labelScale) || 1) : 1;

		drawNode(ctx, n, transform, size, col, nodeStroke, nodeStrokeWidth);

		if (shouldShowLabel && scale > 0.4) {
			const p = worldToScreen(n.x, n.y, transform);

			if (isSelected || isHovered) {
				ctx.beginPath();
				ctx.arc(p.x, p.y, Math.max(6, size * transform.k + 4), 0, Math.PI * 2);
				ctx.strokeStyle = isHovered ? '#18a0fb' : '#24115f';
				ctx.lineWidth = isHovered ? 2 : 3;
				ctx.stroke();
			}

			if (isForcedLabel || isSelected || scale >= selectedCanvasLabelZoomThreshold) {
				const zoomBoost = scale < 0.85 ? 1 + (0.85 - scale) * 0.4 : 1;
				const emphasisBoost = isSelected || isHovered || isForcedLabel ? (scale >= 1 ? 1.12 : 1.04) : 1;
				const labelSize = Math.min(24, Math.max(DEFAULT_NODE_LABEL_FONT_SIZE_PX, DEFAULT_NODE_LABEL_FONT_SIZE_PX * zoomBoost * emphasisBoost * focusLabelScale));
				ctx.font = `${isForcedLabel || isSelected ? '700' : DEFAULT_NODE_LABEL_FONT_WEIGHT} ${labelSize}px var(--font-urbanist, Urbanist, system-ui, sans-serif)`;
				ctx.fillStyle = inactive ? colors.inactiveLabel : colors.defaultText;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				ctx.shadowColor = 'transparent';
				ctx.shadowBlur = 0;
				const labelText = getNodeLabel(n);
				const labelOffset = n.group === 'entity' ? size * transform.k * 1.5 : size * transform.k;
				ctx.fillText(labelText || String(n.id), p.x, p.y + labelOffset + DEFAULT_NODE_LABEL_GAP_PX);
				ctx.textAlign = 'start';
				ctx.textBaseline = 'alphabetic';
			}
		}
	}
}

export { resize as canvasResize };

export { startForceWorker, stopForceWorker } from './force-worker';
/* eslint-disable @typescript-eslint/no-explicit-any */
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';
const GRAPH_API_PATH = '/api/finra/graph';
const MAX_NODES = 400;
const MAX_LINKS = 900;

let pixiApp: any = null;
let linkLayer: any = null;
let nodeLayer: any = null;
let simulation: any = null;
let graphNodes: any[] = [];
let graphLinks: any[] = [];
let nodeSprites = new Map<string, any>();
let graphNodeById = new Map<string, any>();
let graphNeighborIds = new Map<string, Set<string>>();
let selectedNodeId: string | null = null;
let selectedNodeIds = new Set<string>();
let activeDrag: {
	sprite: any;
	node: any;
	offsetX: number;
	offsetY: number;
	moved: boolean;
} | null = null;
let routeNodeListener: ((event: Event) => void) | null = null;
let stopAnimationListener: ((event: Event) => void) | null = null;
let PixiCore: any = null;
let renderRequested = false;
let forceWorker: Worker | null = null;
// Track new nodes for blue ring highlight
let newNodeIds = new Set<string>();

const groupColors: Record<string, number> = {
	individual: 0x4a90e2,
	firm: 0xffa500,
	entity: 0x3ccf8e,
	unknown: 0x999999,
};

function getNodeColor(node: any) {
	return groupColors[node?.group] ?? groupColors.unknown;
}

function getNodeRadius(node: any) {
	return node?.group === 'firm' ? 10 : 7;
}

export function shouldRenderBlueNodeHighlight(node: any, state: { hovered?: boolean; selected?: boolean } = {}) {
	if (!node || node.group !== 'individual') return false;
	return Boolean(state.hovered || state.selected);
}

function buildGraphMaps(nodes: any[], links: any[]) {
	graphNodeById = new Map(nodes.map((node) => [String(node.id), node]));
	graphNeighborIds = new Map();

	for (const link of links) {
		const sourceId = String((link.source?.id ?? link.source) || '');
		const targetId = String((link.target?.id ?? link.target) || '');
		if (!sourceId || !targetId) continue;
		if (!graphNeighborIds.has(sourceId)) graphNeighborIds.set(sourceId, new Set());
		if (!graphNeighborIds.has(targetId)) graphNeighborIds.set(targetId, new Set());
		graphNeighborIds.get(sourceId)?.add(targetId);
		graphNeighborIds.get(targetId)?.add(sourceId);
	}
}

export function requestRender() {
	if (renderRequested) return;
	renderRequested = true;
	if (typeof window === 'undefined') return;
	window.requestAnimationFrame(() => {
		renderRequested = false;
		drawFrame();
	});
}

function getNodeLabel(node: any) {
	// Prefer explicit label or name, otherwise fall back to a readable
	// "Node <id>" string so canvas-rendered nodes always have visible
	// text that won't be treated as a placeholder-only label.
	const raw = String(node?.label || node?.name || node?.id || '').trim();
	if (!raw) return '';

	// Treat purely-numeric or CRD-like tokens as placeholders and replace
	// with a neutral fallback. This mirrors the placeholder detection in
	// the main SVG renderer so canvas labels remain visible for new nodes.
	const isNumeric = /^\d+$/.test(raw);
	const isCrdLike = /^(?:crd|sec)#?\s*\d+$/i.test(raw) || /^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(raw) || /^8-\d+$/i.test(raw);
	if (isNumeric || isCrdLike) {
		const idText = String(node?.id ?? raw).trim();
		return idText ? `Node ${idText}` : raw;
	}

	return raw;
}

async function fetchGraphData() {
	const response = await fetch(`${GRAPH_API_PATH}?limit=${MAX_NODES}`);
	if (!response.ok) {
		throw new Error(`Failed to load graph data: ${response.status}`);
	}
	const graph = await response.json();
	const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const rawLinks = Array.isArray(graph.links) ? graph.links : [];
	const nodes = rawNodes.slice(0, MAX_NODES).map((node: any) => ({ ...node }));
	const ids = new Set(nodes.map((node) => String(node.id)));
	const links = rawLinks
		.filter((link: any) => ids.has(String(link.source)) && ids.has(String(link.target)))
		.slice(0, MAX_LINKS)
		.map((link: any) => ({ ...link }));
	return { nodes, links };
}

function getCanvasElement() {
	return document.getElementById('fg-canvas') as HTMLCanvasElement | null;
}

function beginNodeDrag(sprite: any, node: any, event: any) {
	const localPos = sprite.parent.toLocal(event.data.global);
	activeDrag = {
		sprite,
		node,
		offsetX: localPos.x - sprite.x,
		offsetY: localPos.y - sprite.y,
		moved: false,
	};
	if (typeof node.x === 'number' && typeof node.y === 'number') {
		node.fx = node.x;
		node.fy = node.y;
	}

	const nodeId = String(node.id);
	const neighborIds = graphNeighborIds.get(nodeId);
	if (neighborIds) {
		neighborIds.forEach((neighborId) => {
			const neighbor = graphNodeById.get(neighborId);
			if (neighbor) {
				neighbor.fx = null;
				neighbor.fy = null;
			}
		});
	}

	if (simulation) {
		simulation.alphaTarget(0.3).restart();
	}
	sprite.alpha = 0.85;
}

function dragNode(event: any) {
	if (!activeDrag) return;
	const sprite = activeDrag.sprite;
	const node = activeDrag.node;
	const localPos = sprite.parent.toLocal(event.data.global);
	const newX = localPos.x - activeDrag.offsetX;
	const newY = localPos.y - activeDrag.offsetY;
	const prevX = node.fx ?? node.x ?? 0;
	const prevY = node.fy ?? node.y ?? 0;
	const dx = newX - prevX;
	const dy = newY - prevY;
	activeDrag.moved = activeDrag.moved || Math.hypot(dx, dy) > 1;

	sprite.position.set(newX, newY);
	node.x = newX;
	node.y = newY;
	node.fx = newX;
	node.fy = newY;

	const neighborIds = graphNeighborIds.get(String(node.id));
	if (neighborIds) {
		neighborIds.forEach((neighborId) => {
			const child = graphNodeById.get(neighborId);
			if (child && child.fx == null && child.fy == null) {
				child.x = (child.x ?? 0) + dx;
				child.y = (child.y ?? 0) + dy;
			}
		});
	}

	requestRender();
}

function endNodeDrag() {
	if (!activeDrag) return;
	activeDrag.sprite.alpha = 1;
	activeDrag.node.fx = null;
	activeDrag.node.fy = null;
	if (simulation) {
		simulation.alphaTarget(0).restart();
	}
	activeDrag = null;
}

function buildNodeGraphics(node: any) {
	const radius = getNodeRadius(node);
	const Graphic = PixiCore?.Graphics;
	const Circle = PixiCore?.Circle;
	if (!Graphic || !Circle) {
		throw new Error('Pixi core classes are not initialized');
	}

	const graphic = new Graphic();
	graphic.eventMode = 'static';
	graphic.cursor = 'pointer';
	graphic.hitArea = new Circle(0, 0, radius + 2);
	graphic.cursor = 'pointer';
	graphic.alpha = 1;
	graphic.on('pointerdown', (event: any) => {
		const originalEvent = event?.data?.originalEvent as Event | undefined;
		if (originalEvent && typeof originalEvent.stopPropagation === 'function') {
			originalEvent.stopPropagation();
			originalEvent.preventDefault?.();
		}
		if (onNodeClickCallback) {
			onNodeClickCallback(originalEvent || event, node);
		} else {
			selectNode(node.id);
		}
		beginNodeDrag(graphic, node, event);
	});
	graphic.on('pointerover', () => {
		if (graphic && typeof graphic.tint !== 'undefined') {
			graphic.tint = 0x8ec5ff;
		}
		renderNodeGraphic(graphic, node, selectedNodeIds.has(String(node.id)), { hovered: true });
	});
	graphic.on('pointerout', () => {
		renderNodeGraphic(graphic, node, selectedNodeIds.has(String(node.id)));
		if (graphic && typeof graphic.tint !== 'undefined') {
			graphic.tint = 0xffffff;
		}
	});
	graphic.on('pointermove', (event: any) => {
		dragNode(event);
	});
	graphic.on('pointerup', (event: any) => {
		const originalEvent = event?.data?.originalEvent as Event | undefined;
		if (originalEvent && typeof originalEvent.stopPropagation === 'function') {
			originalEvent.stopPropagation();
			originalEvent.preventDefault?.();
		}
		endNodeDrag();
	});
	graphic.on('pointerupoutside', () => {
		endNodeDrag();
	});
	graphic.on('pointercancel', () => {
		endNodeDrag();
	});

	renderNodeGraphic(graphic, node, selectedNodeIds.has(String(node.id)));
	return graphic;
}

function renderNodeGraphic(graphic: any, node: any, selected: boolean, state: { hovered?: boolean } = {}) {
	const radius = getNodeRadius(node);
	const color = selected ? 0xffdc64 : getNodeColor(node);
	graphic.clear();
	const isNew = newNodeIds.has(String(node.id));
	const shouldRenderBlueOutline = shouldRenderBlueNodeHighlight(node, { hovered: state.hovered, selected });
	if (isNew || selected || shouldRenderBlueOutline) {
		graphic.circle(0, 0, radius + 4).stroke({ width: 3, color: 0x2196f3, alpha: 1 });
	}
	graphic.circle(0, 0, radius)
	       .fill(color)
	       .stroke({ width: 2, color: selected ? 0xffe399 : 0x222222, alpha: selected ? 1 : 0.65 });
}

function drawFrame() {
	if (!pixiApp || !linkLayer || !nodeLayer) return;
	linkLayer.clear();

	for (const link of graphLinks) {
		const source = link.source;
		const target = link.target;
		if (!source || !target || typeof source.x !== 'number' || typeof target.x !== 'number') continue;
		linkLayer.moveTo(source.x, source.y);
		linkLayer.lineTo(target.x, target.y);
	}
	linkLayer.stroke({ width: 1.4, color: 0x8a9aad, alpha: 0.75 });

	for (const node of graphNodes) {
		const sprite = nodeSprites.get(String(node.id));
		if (!sprite) continue;
		sprite.x = node.x ?? 0;
		sprite.y = node.y ?? 0;
	}
}

function updateNodeStyles() {
	for (const node of graphNodes) {
		const sprite = nodeSprites.get(String(node.id));
		if (!sprite) continue;
		renderNodeGraphic(sprite, node, selectedNodeIds.has(String(node.id)));
	}
	requestRender();
}
(window as any).updateNodeStyles = updateNodeStyles;

function selectNode(nodeId: string) {
	if (selectedNodeId === nodeId && selectedNodeIds.has(nodeId)) return;
	selectedNodeId = nodeId;
	selectedNodeIds.add(nodeId);
	updateNodeStyles();
	window.dispatchEvent(new CustomEvent(SELECTED_NODE_ROUTE_EVENT, { detail: { nodeId } }));
	centerOnNode(nodeId);
}

function centerOnNode(nodeId: string) {
	if (!pixiApp) return;
	const node = graphNodeById.get(nodeId);
	if (!node || typeof node.x !== 'number' || typeof node.y !== 'number') return;

	const width = pixiApp.renderer.width;
	const height = pixiApp.renderer.height;
	pixiApp.stage.position.set(width / 2 - node.x, height / 2 - node.y);
}

function installRouteListener() {
	if (routeNodeListener) return;

	routeNodeListener = (event: Event) => {
		const detail = (event as CustomEvent<{ nodeId?: string }>).detail || {};
		const nodeId = String(detail.nodeId || '').trim();
		if (!nodeId) return;
		selectNode(nodeId);
	};

	window.addEventListener(ROUTE_NODE_REQUEST_EVENT, routeNodeListener as EventListener);
}

function teardownRouteListener() {
	if (!routeNodeListener) return;
	window.removeEventListener(ROUTE_NODE_REQUEST_EVENT, routeNodeListener as EventListener);
	routeNodeListener = null;
}

function installStopAnimationListener() {
	if (stopAnimationListener) return;

	stopAnimationListener = () => {
		if (simulation) {
			simulation.stop();
		}
	};

	window.addEventListener('pointerdown', stopAnimationListener, true);
	window.addEventListener('click', stopAnimationListener, true);
}

function teardownStopAnimationListener() {
	if (!stopAnimationListener) return;
	window.removeEventListener('pointerdown', stopAnimationListener, true);
	window.removeEventListener('click', stopAnimationListener, true);
	stopAnimationListener = null;
}

async function createCanvasRenderer(pixi: any) {
	const canvas = getCanvasElement();
	if (!canvas) return;

	const parentElement = canvas.parentElement || document.body;
	if (pixiApp) {
		pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
	}

	(window as any).__FINRA_PIXI_MODULE = pixi;
	const Application = pixi.Application || pixi.default?.Application;
	const Graphics = pixi.Graphics || pixi.default?.Graphics;
	const Container = pixi.Container || pixi.default?.Container;
	const Circle = pixi.Circle || pixi.default?.Circle;
	const Ticker = pixi.Ticker || pixi.default?.Ticker;

	if (!Application || !Graphics || !Container || !Circle) {
		throw new Error('Failed to initialize Pixi renderer: missing core classes.');
	}

	pixiApp = new Application();
	// AMD Radeon 780M + Mesa ANGLE has intermittent SIGILL/tab crashes when Chrome
	// takes the high-performance WebGL path (and WebGPU/Dawn is worse). Prefer a
	// conservative WebGL context and never fall through to WebGPU.
	const baseInit = {
		canvas: canvas,
		resizeTo: parentElement,
		backgroundAlpha: 0,
		antialias: false,
		// Array form replaces the default priority list (does not append webgpu).
		preference: 'webgl',
		failIfMajorPerformanceCaveat: false,
	};
	// Prefer the discrete GPU on hybrid laptops (RTX Max-Q + AMD iGPU) before falling back.
	const initAttempts = [
		{ ...baseInit, powerPreference: 'high-performance' as const },
		{ ...baseInit, powerPreference: 'default' as const },
		{ ...baseInit, powerPreference: 'low-power' as const },
		{ ...baseInit, preference: 'canvas', powerPreference: 'default' as const },
	];
	let initError: unknown = null;
	for (const opts of initAttempts) {
		try {
			await pixiApp.init(opts);
			initError = null;
			break;
		} catch (err) {
			initError = err;
			try {
				pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
			} catch {}
			pixiApp = new Application();
		}
	}
	if (initError) {
		throw initError instanceof Error ? initError : new Error(String(initError));
	}
	try {
		const rendererType = String(
			pixiApp?.renderer?.rendererLogId ||
				pixiApp?.renderer?.name ||
				pixiApp?.renderer?.type ||
				'unknown',
		);
		(window as any).__FINRA_PIXI_RENDERER = rendererType;
		if (typeof console !== 'undefined' && console.info) {
			console.info('[finra-graph] Pixi renderer:', rendererType);
		}
	} catch {}

	linkLayer = new Graphics();
	nodeLayer = new Container();
	pixiApp.stage.addChild(linkLayer);
	pixiApp.stage.addChild(nodeLayer);

	PixiCore = { Application, Graphics, Container, Circle, Ticker };

	(window as any).__FINRA_PIXI_APP = pixiApp;
	(window as any).__FINRA_GRAPH_NODES = graphNodes;
	(window as any).__FINRA_GRAPH_LINKS = graphLinks;

	for (const node of graphNodes) {
		const sprite = buildNodeGraphics(node);
		nodeLayer.addChild(sprite);
		nodeSprites.set(String(node.id), sprite);
	}

	const ticker = pixiApp.ticker ?? (Ticker ? Ticker.shared : null);
	if (!ticker) {
		throw new Error('Failed to initialize Pixi renderer: ticker is unavailable.');
	}

	ticker.add(() => {
		if (!renderRequested) return;
		drawFrame();
		renderRequested = false;
	});

	if (typeof ticker.start === 'function') {
		ticker.start();
	}

	drawFrame();
	if (pixiApp.renderer && typeof pixiApp.renderer.render === 'function') {
		pixiApp.renderer.render(pixiApp.stage);
	}
}

export async function init(_d3: any, options: { initialRouteNodeId?: string | null } = {}) {
	if (typeof window === 'undefined') return;

	const initialRouteNodeId = String(options.initialRouteNodeId || '').trim() || null;
	const PIXI = await import('pixi.js');
	const data = await fetchGraphData();
	graphNodes = data.nodes;
	graphLinks = data.links;

	// Mark all loaded nodes as new
	newNodeIds = new Set(graphNodes.map((n) => String(n.id)));

	graphNodeById = new Map(graphNodes.map((node) => [String(node.id), node]));
	graphLinks.forEach((link) => {
		const sourceId = String(link.source || link.sourceId || '');
		const targetId = String(link.target || link.targetId || '');
		link.source = graphNodeById.get(sourceId) || { id: sourceId, x: 0, y: 0 };
		link.target = graphNodeById.get(targetId) || { id: targetId, x: 0, y: 0 };
	});

	buildGraphMaps(graphNodes, graphLinks);

	await createCanvasRenderer(PIXI);

	const canvas = getCanvasElement();
	const width = canvas?.clientWidth || 800;
	const height = canvas?.clientHeight || 600;

	graphNodes.forEach((node) => {
		Object.assign(node, {
			x: width / 2 + (Math.random() - 0.5) * 80,
			y: height / 2 + (Math.random() - 0.5) * 80,
		});
	});

	// Prefer running the force simulation inside a Web Worker to avoid
	// blocking the main thread. Try to use a prebuilt production worker
	// at /workers/d3-force-worker.js (served from /public). If that fails
	// fall back to the legacy Blob-based simple simulation or main-thread d3.
	if (typeof window !== 'undefined' && typeof (window as any).Worker === 'function') {
		let triedStaticWorker = false;
		try {
			// Attempt to use the bundled worker asset
			triedStaticWorker = true;
			forceWorker = new Worker('/workers/d3-force-worker.js');
			forceWorker.onmessage = (ev) => {
				const msg = ev.data || {};
				if (msg.type === 'ready') {
					// worker ready
				} else if (msg.type === 'tick' && Array.isArray(msg.nodes)) {
					for (const p of msg.nodes) {
						const node = graphNodeById.get(String(p.id));
						if (node) {
							node.x = p.x;
							node.y = p.y;
						}
					}
					requestRender();
				} else if (msg.type === 'error') {
					// worker cannot run (missing d3), fall through to fallback below
					console.warn('d3-force worker reported error:', msg.error);
					try {
						forceWorker.terminate();
					} catch (e) {}
					forceWorker = null;
				}
			};
			forceWorker.postMessage({
				type: 'init',
				nodes: graphNodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
				links: graphLinks.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target })),
				width,
				height,
			});
			forceWorker.postMessage({ type: 'start' });
		} catch (e) {
			// static worker failed — try the Blob fallback
			console.warn('d3-force static worker failed; falling back to Blob worker or main-thread simulation.', e);
			if (forceWorker) {
				try {
					forceWorker.terminate();
				} catch (err) {}
				forceWorker = null;
			}
		}

		if (!forceWorker) {
			// Blob fallback: simple built-in simulation (previous implementation)
			try {
				const workerCode = `
					let nodes = [];
					let links = [];
					let running = false;
					let width = 800, height = 600;
					function stepSim() {
						if (!running) return;
						const k = 0.02;
						for (let i = 0; i < nodes.length; i++) {
							let ni = nodes[i];
							let fx = 0, fy = 0;
							for (let j = 0; j < nodes.length; j++) {
								if (i === j) continue;
								const nj = nodes[j];
								let dx = ni.x - nj.x;
								let dy = ni.y - nj.y;
								let dist2 = dx*dx + dy*dy + 0.01;
								let force = 1000 / dist2;
								fx += (dx/dist2) * force;
								fy += (dy/dist2) * force;
							}
							ni.vx = (ni.vx || 0) + fx * 0.001;
							ni.vy = (ni.vy || 0) + fy * 0.001;
						}
						for (let l of links) {
							const s = nodes.find(n => String(n.id) === String(l.source));
							const t = nodes.find(n => String(n.id) === String(l.target));
							if (!s || !t) continue;
							const dx = t.x - s.x;
							const dy = t.y - s.y;
							const dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
							const desired = 70;
							const diff = dist - desired;
							const f = 0.001 * diff;
							const nx = (dx/dist) * f;
							const ny = (dy/dist) * f;
							s.vx = (s.vx || 0) + nx;
							s.vy = (s.vy || 0) + ny;
							t.vx = (t.vx || 0) - nx;
							t.vy = (t.vy || 0) - ny;
						}
						for (let n of nodes) {
							n.x = (n.x || width/2) + (n.vx || 0);
							n.y = (n.y || height/2) + (n.vy || 0);
							n.vx *= 0.9;
							n.vy *= 0.9;
						}
						postMessage({ type: 'tick', nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y })) });
						setTimeout(stepSim, 16);
					}
					onmessage = function(e) {
						const m = e.data || {};
						if (m.type === 'init') {
							nodes = m.nodes.map(n => ({ id: n.id, x: n.x || 0, y: n.y || 0 }));
							links = m.links.map(l => ({ source: l.source, target: l.target }));
							width = m.width || width;
							height = m.height || height;
							postMessage({ type: 'ready' });
						} else if (m.type === 'start') {
							running = true; stepSim();
						} else if (m.type === 'stop') { running = false; }
						else if (m.type === 'updateNodes') {
							for (const p of m.positions || []) {
								const n = nodes.find(x => String(x.id) === String(p.id)); if (n) { n.x = p.x; n.y = p.y; }
							}
						}
					};
				`;
				const blob = new Blob([workerCode], { type: 'application/javascript' });
				forceWorker = new Worker(URL.createObjectURL(blob));
				forceWorker.onmessage = (ev) => {
					const msg = ev.data || {};
					if (msg.type === 'tick' && Array.isArray(msg.nodes)) {
						for (const p of msg.nodes) {
							const node = graphNodeById.get(String(p.id));
							if (node) {
								node.x = p.x;
								node.y = p.y;
							}
						}
						requestRender();
					}
				};
				forceWorker.postMessage({
					type: 'init',
					nodes: graphNodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
					links: graphLinks.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target })),
					width,
					height,
				});
				forceWorker.postMessage({ type: 'start' });
			} catch (e2) {
				console.warn('Fallback worker failed; falling back to main-thread d3.', e2);
				simulation = _d3
					.forceSimulation(graphNodes)
					.force(
						'link',
						_d3
							.forceLink(graphLinks)
							.id((d: any) => d.id)
							.distance(70)
							.strength(0.75),
					)
					.force('charge', _d3.forceManyBody().strength(-150).theta(0.9))
					.force('center', _d3.forceCenter(width / 2, height / 2))
					.force(
						'collision',
						_d3
							.forceCollide()
							.radius((d: any) => getNodeRadius(d) + 2)
							.strength(1),
					)
					.velocityDecay(0.72)
					.alphaDecay(0.05)
					.on('tick', () => {
						requestRender();
					})
					.on('end', drawFrame);
			}
		}
	} else {
		simulation = _d3
			.forceSimulation(graphNodes)
			.force(
				'link',
				_d3
					.forceLink(graphLinks)
					.id((d: any) => d.id)
					.distance(70)
					.strength(0.75),
			)
			.force('charge', _d3.forceManyBody().strength(-150).theta(0.9))
			.force('center', _d3.forceCenter(width / 2, height / 2))
			.force(
				'collision',
				_d3
					.forceCollide()
					.radius((d: any) => getNodeRadius(d) + 2)
					.strength(1),
			)
			.velocityDecay(0.72)
			.alphaDecay(0.05)
			.on('tick', () => {
				requestRender();
			})
			.on('end', drawFrame);
	}

	installRouteListener();
	installStopAnimationListener();

	// Add canvas click handler to clear new node highlights
	const clearNewNodeHighlight = (e: MouseEvent) => {
		// Only clear if click is on canvas, not on a node
		const canvas = getCanvasElement();
		if (canvas && e.target === canvas) {
			if (newNodeIds.size > 0) {
				newNodeIds.clear();
				updateNodeStyles();
			}
		}
	};
	window.addEventListener('click', clearNewNodeHighlight, true);

	if (initialRouteNodeId) {
		selectNode(initialRouteNodeId);
	}
}

export function destroy() {
	if (simulation) {
		simulation.stop();
		simulation = null;
	}
	if (forceWorker) {
		try {
			forceWorker.postMessage({ type: 'stop' });
		} catch (e) {}
		try {
			forceWorker.terminate();
		} catch (e) {}
		forceWorker = null;
	}
	if (pixiApp) {
		pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
		pixiApp = null;
	}
	nodeSprites.clear();
	graphNodeById.clear();
	graphNeighborIds.clear();
	graphNodes = [];
	graphLinks = [];
	teardownRouteListener();
	teardownStopAnimationListener();
}

export let onNodeClickCallback: ((event: any, node: any) => void) | null = null;
export function setOnNodeClickCallback(cb: (event: any, node: any) => void) {
	onNodeClickCallback = cb;
}


export async function createPixiRenderer(parent: HTMLElement) {
	const PIXI = await import('pixi.js');
	
	let canvas = document.getElementById('fg-canvas') as HTMLCanvasElement | null;
	if (!canvas) {
		canvas = document.createElement('canvas');
		canvas.id = 'fg-canvas';
		canvas.style.position = 'absolute';
		canvas.style.left = '0';
		canvas.style.top = '0';
		canvas.style.width = '100%';
		canvas.style.height = '100%';
		canvas.style.zIndex = '0';
		parent.insertBefore(canvas, parent.firstChild);
	}

	await createCanvasRenderer(PIXI);

	return {
		drawFrame: (nodes: any[], links: any[], transform: any, options: any) => {
			graphNodes = nodes;
			graphLinks = links;
			
			// Ensure all nodes have sprites
			for (const node of graphNodes) {
				const idStr = String(node.id);
				if (!nodeSprites.has(idStr)) {
					const sprite = buildNodeGraphics(node);
					nodeLayer.addChild(sprite);
					nodeSprites.set(idStr, sprite);
				}
			}

            // Remove sprites for nodes that no longer exist
            const nodeIds = new Set(graphNodes.map(n => String(n.id)));
            for (const [id, sprite] of nodeSprites.entries()) {
                if (!nodeIds.has(id)) {
                    nodeLayer.removeChild(sprite);
                    sprite.destroy();
                    nodeSprites.delete(id);
                }
            }
			
			if (pixiApp && pixiApp.stage) {
				pixiApp.stage.position.set(transform.x, transform.y);
				pixiApp.stage.scale.set(transform.k);
			}
			
			updateNodeStyles();
			drawFrame();
			if (pixiApp && pixiApp.renderer) {
				pixiApp.renderer.render(pixiApp.stage);
			}
		},
		destroy: () => {
			if (pixiApp) {
				pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
				pixiApp = null;
			}
			if (canvas && canvas.parentNode) {
				canvas.parentNode.removeChild(canvas);
			}
		}
	};
}
