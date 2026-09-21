export type GraphWorkerTransform = { x: number; y: number; k: number };

export type GraphWorkerFrameMessage = {
	type: 'frame';
	nodes: Array<{
		id: string | number;
		x: number;
		y: number;
		group?: string;
		radius?: number;
		isInactive?: boolean;
		isStub?: boolean;
		selected?: boolean;
		isHighlighted?: boolean;
	}>;
	links: Array<{
		source: string | number;
		target: string | number;
		relationship?: string;
		isCurrent?: boolean;
		isInactive?: boolean;
	}>;
	width: number;
	height: number;
	selectedNodeId?: string | number | null;
	highlightedNodeIds?: Array<string | number>;
	transform: GraphWorkerTransform;
};

export function buildGraphWorkerFrameMessage({
	nodes,
	links,
	width,
	height,
	selectedNodeId,
	highlightedNodeIds,
	transform,
}: {
	nodes: Array<Record<string, any>>;
	links: Array<Record<string, any>>;
	width: number;
	height: number;
	selectedNodeId?: string | number | null;
	highlightedNodeIds?: Array<string | number>;
	transform: GraphWorkerTransform;
}): GraphWorkerFrameMessage {
	return {
		type: 'frame',
		nodes: nodes.map((node) => ({
			id: node.id,
			x: Number(node.x) || 0,
			y: Number(node.y) || 0,
			group: node.group,
			radius: node.radius,
			isInactive: Boolean(node.isInactive),
			isStub: Boolean(node.isStub),
			selected: Boolean(node.selected),
			isHighlighted: Boolean(node.isHighlighted),
		})),
		links: links.map((link) => ({
			source: link.source?.id ?? link.source,
			target: link.target?.id ?? link.target,
			relationship: link.relationship,
			isCurrent: Boolean(link.isCurrent),
			isInactive: Boolean(link.isInactive),
		})),
		width,
		height,
		selectedNodeId: selectedNodeId ?? null,
		highlightedNodeIds: highlightedNodeIds ?? [],
		transform,
	};
}

export function createGraphOffscreenRenderer(parent: HTMLElement) {
	if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
	if (typeof window.OffscreenCanvas === 'undefined' || typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'undefined') {
		return null;
	}

	const canvas = document.createElement('canvas');
	canvas.id = 'fg-offscreen-canvas';
	canvas.style.position = 'absolute';
	canvas.style.left = '0';
	canvas.style.top = '0';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	canvas.style.zIndex = '1';
	canvas.style.pointerEvents = 'none';
	parent.style.position = parent.style.position || 'relative';
	parent.appendChild(canvas);

	const worker = new Worker('/workers/graph-offscreen-worker.js');
	const offscreen = canvas.transferControlToOffscreen();
	const resize = () => {
		const rect = parent.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		canvas.width = Math.floor(width * (window.devicePixelRatio || 1));
		canvas.height = Math.floor(height * (window.devicePixelRatio || 1));
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		worker.postMessage({ type: 'resize', width, height, devicePixelRatio: window.devicePixelRatio || 1 });
	};

	worker.postMessage({ type: 'init', canvas: offscreen, width: 1, height: 1, devicePixelRatio: window.devicePixelRatio || 1 }, [offscreen]);
	resize();
	window.addEventListener('resize', resize);

	return {
		canvas,
		worker,
		resize,
		drawFrame: (payloadOrNodes: any, links?: any[], transform?: GraphWorkerTransform, opts?: Record<string, unknown>) => {
			const frame =
				Array.isArray(payloadOrNodes) ?
					buildGraphWorkerFrameMessage({
						nodes: payloadOrNodes,
						links: links || [],
						width: Math.max(1, Math.floor(parent.getBoundingClientRect().width)),
						height: Math.max(1, Math.floor(parent.getBoundingClientRect().height)),
						selectedNodeId: (opts?.selectedNodeId as string | number | null | undefined) ?? null,
						highlightedNodeIds: Array.isArray(opts?.highlightedNodeIds) ? (opts.highlightedNodeIds as Array<string | number>) : [],
						transform: transform || { x: 0, y: 0, k: 1 },
					})
				:	payloadOrNodes;
			worker.postMessage({ ...frame, type: 'frame' });
		},
		destroy: () => {
			try {
				window.removeEventListener('resize', resize);
			} catch {}
			try {
				worker.terminate();
			} catch {}
			try {
				if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
			} catch {}
		},
	};
}
