import { expect, test, type Page } from '@playwright/test';

import { readStoredSession, readStoredSessionState, seedStoredSession } from './helpers/finra-e2e';

async function setClearedSession(page: Page) {
	await page.evaluate(() => {
		const envelope = {
			expiresAt: Date.now() + 60_000,
			data: { cleared: true },
		};
		localStorage.setItem('finra_session', JSON.stringify(envelope));
		sessionStorage.removeItem('finra_session');
		localStorage.removeItem('finra_selection_log');
		localStorage.removeItem('finra_sidebar_pinned');
		localStorage.removeItem('finra_selection_log_pinned');
	});
}

test('New empty custom sessions autofocus the fetch input', async ({ page }) => {
	await page.goto('/');
	await setClearedSession(page);
	await page.goto('/');

	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected the fetch input to receive focus for a new empty session',
		})
		.toBe('fg-fetch-input');
});

test('Reset Session overwrites persisted state with a cleared marker that survives reload', async ({ page }) => {
	await page.goto('/');

	await seedStoredSession(page, {
		selectedNodeId: 'person:3102054',
		sidebarViewMode: 'log',
		highlightedNodes: [{ id: 'person:3102054', hops: 1 }],
		extraNodeIds: ['person:3102054', 'firm:143571'],
	});
	await setClearedSession(page);
	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected Reset Session to move focus back to the fetch input',
		})
		.toBe('fg-fetch-input');

	await expect
		.poll(
			async () => {
				return readStoredSessionState(page);
			},
			{
				timeout: 10_000,
				message: 'expected Reset Session to persist a cleared marker and remove legacy session storage',
			},
		)
		.toEqual({ cleared: true, hasExpiry: true, legacyCleared: true });

	await page.goto('/');

	await expect(page.locator('#fg-main')).toBeVisible();
	await expect(page.locator('#fg-sidebar')).toHaveClass(/hidden/);
	await expect
		.poll(
			async () => {
				const session = await readStoredSession(page);
				return session?.data?.cleared === true;
			},
			{
				timeout: 10_000,
				message: 'expected the cleared session marker to survive reload',
			},
		)
		.toBe(true);
	await expect
		.poll(async () => page.evaluate(() => document.activeElement?.id || ''), {
			timeout: 10_000,
			message: 'expected the fetch input to regain focus after reloading a cleared session',
		})
		.toBe('fg-fetch-input');
});

test('Reset Session still allows a fresh fetch after clearing the graph', async ({ page }) => {
	await page.route('**/api/finra/graph-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ nodes: [], links: [], matchedIds: [] }),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: {
					hits: [
						{
							_source: {
								ind_source_id: '999999',
								ind_firstname: 'Reset',
								ind_lastname: 'Fetch',
								ind_current_employments: [
									{
										firmId: '143571',
										firm_name: 'Reset Fetch Advisors',
									},
								],
							},
						},
					],
				},
			}),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});

	await page.goto('/');
	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-database-search');

	await seedStoredSession(page, {
		selectedNodeId: 'person:3102054',
		sidebarViewMode: 'log',
		highlightedNodes: [{ id: 'person:3102054', hops: 1 }],
		extraNodeIds: ['person:3102054', 'firm:143571'],
	});
	await setClearedSession(page);
	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await expect(fetchInput).toBeVisible();

	await fetchInput.fill('Reset Fetch');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected fetch to add nodes after a reset session',
		})
		.toBeGreaterThan(0);
	await expect(page.locator('.fg-node').filter({ hasText: 'Reset Fetch INDIVIDUAL CRD: 999999' })).toHaveCount(1);
});
