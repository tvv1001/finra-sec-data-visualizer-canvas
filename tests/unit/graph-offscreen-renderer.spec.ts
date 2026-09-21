import { describe, expect, it, vi } from 'vitest';
import { buildGraphWorkerFrameMessage, createGraphOffscreenRenderer } from '../../src/lib/graph-offscreen-renderer';

describe('graph offscreen renderer worker payloads', () => {
	it('serializes the latest node and link state for the worker without leaking transient fields', () => {
		const nodes = [
			{ id: 'person:1', x: 10, y: 20, group: 'individual', fx: null, fy: null },
			{ id: 'firm:1', x: 40, y: 60, group: 'firm', fx: 12, fy: 13 },
		];
		const links = [{ source: 'person:1', target: 'firm:1', relationship: 'employed_by' }];

		const payload = buildGraphWorkerFrameMessage({
			nodes,
			links,
			width: 800,
			height: 600,
			selectedNodeId: 'person:1',
			highlightedNodeIds: ['firm:1'],
			transform: { x: 4, y: 5, k: 1.25 },
		});

		expect(payload.type).toBe('frame');
		expect(payload.width).toBe(800);
		expect(payload.height).toBe(600);
		expect(payload.nodes).toHaveLength(2);
		expect(payload.nodes[0]).toMatchObject({ id: 'person:1', x: 10, y: 20, group: 'individual' });
		expect(payload.nodes[0]).not.toHaveProperty('fx');
		expect(payload.nodes[0]).not.toHaveProperty('fy');
		expect(payload.links[0]).toMatchObject({ source: 'person:1', target: 'firm:1', relationship: 'employed_by' });
		expect(payload.selectedNodeId).toBe('person:1');
		expect(payload.highlightedNodeIds).toEqual(['firm:1']);
		expect(payload.transform).toEqual({ x: 4, y: 5, k: 1.25 });
	});

	it('creates a renderer only when the browser supports offscreen canvas workers', () => {
		const canvasElement = document.createElement('canvas');
		const transferSpy = vi.fn(() => canvasElement);
		const postMessageSpy = vi.fn();
		const terminateSpy = vi.fn();
		const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
		const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
		vi.stubGlobal(
			'Worker',
			class {
				postMessage = postMessageSpy;
				terminate = terminateSpy;
			},
		);
		vi.stubGlobal('OffscreenCanvas', class {});
		const originalTransferControlToOffscreen = HTMLCanvasElement.prototype.transferControlToOffscreen;
		HTMLCanvasElement.prototype.transferControlToOffscreen = transferSpy as any;

		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const renderer = createGraphOffscreenRenderer(parent);

		expect(renderer).not.toBeNull();
		expect(postMessageSpy).toHaveBeenCalled();
		expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
		renderer?.destroy();
		expect(terminateSpy).toHaveBeenCalled();
		removeEventListenerSpy.mockRestore();
		addEventListenerSpy.mockRestore();
		HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransferControlToOffscreen;
		vi.unstubAllGlobals();
		parent.remove();
	});
});
