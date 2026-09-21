type Transform = { x: number; y: number; k: number };

type GraphNode = {
	id: string | number;
	x?: number;
	y?: number;
	fx?: number;
	fy?: number;
	group?: string;
	_deg?: { total?: number };
};
type GraphLink = { source?: GraphNode | string | number; target?: GraphNode | string | number; relationship?: string };

function toId(value: string | number | GraphNode | undefined) {
	if (typeof value === 'object' && value && 'id' in value) {
		return String(value.id ?? '').trim();
	}
	return String(value ?? '').trim();
}

function worldToScreen(x: number, y: number, transform: Transform) {
	return {
		x: transform.x + x * transform.k,
		y: transform.y + y * transform.k,
	};
}

function isWithinViewport(node: GraphNode, transform: Transform, width: number, height: number, margin = 160) {
	const point = worldToScreen(Number(node.x) || 0, Number(node.y) || 0, transform);
	return point.x >= -margin && point.x <= width + margin && point.y >= -margin && point.y <= height + margin;
}

export function getLargeGraphRenderBudget(nodeCount: number, zoom = 1) {
	const normalizedZoom = Number.isFinite(zoom) ? zoom : 1;
	if (nodeCount <= 1200) return Math.min(nodeCount, 420);
	if (nodeCount <= 3000) return Math.min(nodeCount, 560);
	if (nodeCount <= 5000) return Math.min(nodeCount, 650);
	if (nodeCount <= 10000) return Math.min(nodeCount, 780);
	if (nodeCount <= 20000) return Math.min(nodeCount, 900);
	const budget = Math.max(780, Math.floor(980 / Math.max(0.45, normalizedZoom)));
	return Math.min(nodeCount, Math.min(980, budget));
}

export function getProgressiveLoadBudget(nodeCount: number, zoom = 1, revealPhase = 0) {
	const baseBudget = getLargeGraphRenderBudget(nodeCount, zoom);
	if (nodeCount <= 1200) return baseBudget;

	const phaseSteps = [0.18, 0.35, 0.55, 0.78, 1];
	const phaseIndex = Math.max(0, Math.min(phaseSteps.length - 1, Math.floor(revealPhase)));
	const targetBudget = Math.max(120, Math.floor(baseBudget * phaseSteps[phaseIndex]));
	return Math.min(baseBudget, targetBudget);
}

export function shouldUseInitialSvgFallback(nodeCount: number) {
	return false;
}

export function buildLargeGraphRenderPlan(
	nodes: GraphNode[],
	links: GraphLink[],
	transform: Transform,
	options: { width?: number; height?: number; selectedId?: string | number; maxVisibleNodes?: number; logLabelNodeIds?: Array<string | number> } = {},
) {
	const width = Math.max(1, options.width ?? 1200);
	const height = Math.max(1, options.height ?? 800);
	const selectedId = toId(options.selectedId);
	const maxVisibleNodes = Math.max(1, options.maxVisibleNodes ?? getLargeGraphRenderBudget(nodes.length, transform.k));
	const forcedLabelIds = new Set((options.logLabelNodeIds || []).map((entry) => toId(entry)));

	const priority = (node: GraphNode) => {
		const id = toId(node.id);
		const degree = Number(node?._deg?.total) || 0;
		const isSelected = id === selectedId;
		const isForced = forcedLabelIds.has(id);
		return Number(isSelected) * 1000 + Number(isForced) * 200 + degree;
	};

	const visibleByViewport = nodes.filter((node) => isWithinViewport(node, transform, width, height));
	const priorityList = [...nodes].sort((a, b) => priority(b) - priority(a));

	const chosen = new Set<string>();
	if (selectedId) chosen.add(selectedId);

	for (const node of visibleByViewport) {
		chosen.add(toId(node.id));
	}

	for (const node of priorityList) {
		if (chosen.size >= maxVisibleNodes) break;
		chosen.add(toId(node.id));
	}

	const visibleNodes = nodes.filter((node) => chosen.has(toId(node.id)));
	const visibleNodeIds = new Set(visibleNodes.map((node) => toId(node.id)));
	const visibleLinks = links.filter((link) => {
		const sourceId = toId(link.source);
		const targetId = toId(link.target);
		return Boolean(sourceId && targetId && (visibleNodeIds.has(sourceId) || visibleNodeIds.has(targetId)));
	});

	return {
		visibleNodeIds,
		visibleNodes,
		visibleLinks,
		hiddenNodeCount: Math.max(0, nodes.length - visibleNodes.length),
	};
}
