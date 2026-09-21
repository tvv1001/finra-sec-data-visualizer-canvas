/**
 * One-shot dashboard → graph bridge for Queue graph CRDs.
 * Uses sessionStorage (not URL query params) so Graph navigation stays clean.
 *
 * When people are multi-selected from a firm's connection list, include `anchorFirmId`
 * + lightweight `people` metadata so the graph can draw employment links immediately
 * without N individual detail fetches (which dropped previous-employment edges and
 * tanked performance past ~20 people).
 */

export const QUEUE_GRAPH_BRIDGE_KEY = 'finra_queue_graph_bridge';

export type QueueGraphBridgePerson = {
	crd: string;
	name?: string;
	/** true = current connection on the anchor firm; false = previous */
	isCurrent?: boolean;
};

export type QueueGraphBridgePayload = {
	nodeIds: string[];
	/** Firm the people were selected from (e.g. dashboard firm connections → Graph). */
	anchorFirmId?: string;
	anchorFirmName?: string;
	people?: QueueGraphBridgePerson[];
	writtenAt: number;
};

function normalizeBridgeNodeIds(nodeIds: unknown): string[] {
	if (!Array.isArray(nodeIds)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of nodeIds) {
		const id = String(raw || '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function normalizePeople(people: unknown): QueueGraphBridgePerson[] {
	if (!Array.isArray(people)) return [];
	const seen = new Set<string>();
	const out: QueueGraphBridgePerson[] = [];
	for (const raw of people) {
		const crd = String((raw as any)?.crd ?? (raw as any)?.id ?? '').trim();
		if (!/^\d{1,10}$/.test(crd) || seen.has(crd)) continue;
		seen.add(crd);
		out.push({
			crd,
			name: String((raw as any)?.name || (raw as any)?.title || '').trim() || undefined,
			isCurrent: (raw as any)?.isCurrent === true,
		});
	}
	return out;
}

export type WriteQueueGraphBridgeOptions = {
	anchorFirmId?: string | null;
	anchorFirmName?: string | null;
	people?: QueueGraphBridgePerson[];
};

/** Persist Queue graph node ids (+ optional firm-seed people) for the next graph page load. */
export function writeQueueGraphBridge(nodeIds: string[], options: WriteQueueGraphBridgeOptions = {}): void {
	if (typeof window === 'undefined') return;
	const normalized = normalizeBridgeNodeIds(nodeIds);
	const people = normalizePeople(options.people);
	const anchorFirmId = String(options.anchorFirmId || '')
		.trim()
		.replace(/^\D+/, '');
	const firmId = /^\d{1,10}$/.test(anchorFirmId) ? anchorFirmId : '';
	if (firmId && !normalized.includes(`firm:${firmId}`)) {
		normalized.unshift(`firm:${firmId}`);
	}
	for (const person of people) {
		const personId = `person:${person.crd}`;
		if (!normalized.includes(personId)) normalized.push(personId);
	}
	try {
		if (!normalized.length) {
			window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
			return;
		}
		const payload: QueueGraphBridgePayload = {
			nodeIds: normalized,
			writtenAt: Date.now(),
			...(firmId ? { anchorFirmId: firmId } : {}),
			...(options.anchorFirmName ? { anchorFirmName: String(options.anchorFirmName).trim() } : {}),
			...(people.length ? { people } : {}),
		};
		window.sessionStorage.setItem(QUEUE_GRAPH_BRIDGE_KEY, JSON.stringify(payload));
	} catch {
		/* ignore quota / private mode */
	}
}

/** Read the current bridge payload without consuming it. */
export function readQueueGraphBridgePayload(): QueueGraphBridgePayload | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as QueueGraphBridgePayload | string[];
		if (Array.isArray(parsed)) {
			const nodeIds = normalizeBridgeNodeIds(parsed);
			return nodeIds.length ? { nodeIds, writtenAt: Date.now() } : null;
		}
		const nodeIds = normalizeBridgeNodeIds(parsed?.nodeIds);
		if (!nodeIds.length) return null;
		const anchorFirmId = String(parsed?.anchorFirmId || '').trim();
		return {
			nodeIds,
			writtenAt: Number(parsed?.writtenAt) || Date.now(),
			...( /^\d{1,10}$/.test(anchorFirmId) ? { anchorFirmId } : {}),
			...(parsed?.anchorFirmName ? { anchorFirmName: String(parsed.anchorFirmName) } : {}),
			people: normalizePeople(parsed?.people),
		};
	} catch {
		return null;
	}
}

/** Read and clear the bridge payload (one-shot). Returns full payload for seeded hydrate. */
export function consumeQueueGraphBridgePayload(): QueueGraphBridgePayload | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.sessionStorage.getItem(QUEUE_GRAPH_BRIDGE_KEY);
		window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as QueueGraphBridgePayload | string[];
		if (Array.isArray(parsed)) {
			const nodeIds = normalizeBridgeNodeIds(parsed);
			return nodeIds.length ? { nodeIds, writtenAt: Date.now() } : null;
		}
		const nodeIds = normalizeBridgeNodeIds(parsed?.nodeIds);
		if (!nodeIds.length) return null;
		const anchorFirmId = String(parsed?.anchorFirmId || '').trim();
		return {
			nodeIds,
			writtenAt: Number(parsed?.writtenAt) || Date.now(),
			...( /^\d{1,10}$/.test(anchorFirmId) ? { anchorFirmId } : {}),
			...(parsed?.anchorFirmName ? { anchorFirmName: String(parsed.anchorFirmName) } : {}),
			people: normalizePeople(parsed?.people),
		};
	} catch {
		try {
			window.sessionStorage.removeItem(QUEUE_GRAPH_BRIDGE_KEY);
		} catch {
			/* ignore */
		}
		return null;
	}
}

/** Read and clear bridge node ids only (legacy helper). */
export function consumeQueueGraphBridge(): string[] {
	return consumeQueueGraphBridgePayload()?.nodeIds || [];
}
