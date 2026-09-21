import { expect, test } from '@playwright/test';
import { QUEUE_GRAPH_BRIDGE_KEY } from '../../src/lib/queueGraphBridge';

test('Graph button bridges Queue graph CRDs without query string', async ({ page }) => {
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 } }),
		});
	});
	await page.route('**/api/finra/**', async (route) => {
		const url = route.request().url();
		if (url.includes('/api/finra/individual/3102054')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ok: true,
					nodes: [{ id: 'person:3102054', group: 'individual', crd: '3102054', label: 'Regression Person One' }],
					links: [],
				}),
			});
			return;
		}
		if (url.includes('/api/finra/graph') || url.includes('/api/finra/profile')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ nodes: [], links: [], meta: {} }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, results: [], nodes: [], links: [] }),
		});
	});

	await page.goto('/dashboard');
	await page.evaluate(() => {
		localStorage.setItem(
			'finra_dashboard_history',
			JSON.stringify([
				{
					id: '3102054',
					entity: 'individual',
					sources: [{ source: 'finra', label: 'FINRA' }],
					name: 'Regression Person One',
					fetchedAt: new Date().toISOString(),
					lastVisitedAt: new Date().toISOString(),
					visitCount: 1,
				},
			]),
		);
	});
	await page.reload();
	await expect(page.getByText('Queue graph', { exact: false })).toBeVisible();
	const graphLink = page.getByRole('link', { name: 'Graph' });
	await expect(graphLink).toHaveAttribute('href', /\/individual\/3102054/);

	await graphLink.click();

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname + window.location.search), {
			timeout: 20_000,
			message: 'expected Graph navigation to the individual route without selected=',
		})
		.toBe('/individual/3102054');

	const href = await page.evaluate(() => window.location.href);
	expect(href).not.toContain('selected=');
	expect(href).not.toContain('isolate=');

	// Bridge is written on click then consumed during graph init (one-shot).
	await expect
		.poll(
			async () =>
				page.evaluate((key) => {
					return sessionStorage.getItem(key);
				}, QUEUE_GRAPH_BRIDGE_KEY),
			{ timeout: 30_000, message: 'expected the one-shot bridge to be consumed after graph init' },
		)
		.toBeNull();

	// Graph click ends the Queue graph session — history is cleared for the next dashboard visit.
	await expect
		.poll(async () => page.evaluate(() => localStorage.getItem('finra_dashboard_history')), {
			timeout: 5_000,
			message: 'expected Queue graph history to be cleared after Graph navigation',
		})
		.toBeNull();
});
