import { test, expect } from '@playwright/test';

test.describe('render order (2.5D) checks', () => {
	test('selecting a node promotes its node and connected links to top layer', async ({ page, baseURL }) => {
		await page.goto(`${baseURL}/firm/161724`);

		// wait for client graph nodes to appear
		await page.waitForFunction(() => typeof window !== 'undefined' && Array.isArray((window as any).__FINRA_GRAPH_NODES) && (window as any).__FINRA_GRAPH_NODES.length > 0, {
			timeout: 20000,
		});

		// pick a candidate node id from the global pixi/dataset
		const candidateId: string | null = await page.evaluate(() => {
			try {
				const arr = (window as any).__FINRA_GRAPH_NODES || [];
				return arr.length ? String(arr[0].id) : null;
			} catch (e) {
				return null;
			}
		});
		expect(candidateId, 'expected a candidate node id from __FINRA_GRAPH_NODES').toBeTruthy();

		// read current render-order timestamp (may be undefined)
		const beforeTs = await page.evaluate(() => ((window as any).__FG_RENDER_ORDER || { timestamp: 0 }).timestamp || 0);

		// dispatch route-node-request to select/center the node on the client and trigger layering
		await page.evaluate((id) => {
			try {
				window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { nodeId: id } }));
			} catch (e) {
				// ignore
			}
		}, candidateId);

		// wait for render-order to update
		await page.waitForFunction(
			(ts) => {
				// eslint-disable-next-line no-undef
				return typeof window !== 'undefined' && (window as any).__FG_RENDER_ORDER && (window as any).__FG_RENDER_ORDER.timestamp > ts;
			},
			beforeTs,
			{ timeout: 10000 },
		);

		// read render order
		const ro = await page.evaluate(() => (window as any).__FG_RENDER_ORDER || { nodes: [], links: [] });
		expect(ro).toBeTruthy();

		const nodeEntry = ro.nodes.find((n: any) => String(n.id) === String('' + (window as any).__FINRA_GRAPH_NODES[0]?.id));
		// If the selected node isn't promoted to top for some reason, fail the test
		expect(nodeEntry, `expected render-order entry for node ${candidateId}`).toBeTruthy();
		expect(nodeEntry.layer).toBe('top');

		// The selected node stays on top, while connected links remain beneath it.
		const linkKeysForNode = ro.links.filter((l: any) => String(l.key).includes(String(candidateId)));
		expect(linkKeysForNode.length).toBeGreaterThan(0);
		const anyTopLink = linkKeysForNode.some((l: any) => l.layer === 'top');
		expect(anyTopLink).toBeFalsy();
		const hasActiveUnderNodeLink = linkKeysForNode.some((l: any) => l.layer === 'mid' || l.layer === 'bottom');
		expect(hasActiveUnderNodeLink).toBeTruthy();
	});
});
