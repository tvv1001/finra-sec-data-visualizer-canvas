import { expect, test } from '@playwright/test';

test('Dashboard selection history clicks through to a record detail view', async ({ page }) => {
	await page.route('**/api/finra/search**', async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('type') === 'individual') {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					results: [
						{
							ind_source_id: '3102054',
							name: 'Seon Lyndon Harry',
							bcScope: 'Active',
							currentEmployment: [{ firmId: '143571', firmName: 'Example Firm' }],
						},
					],
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ results: [] }),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/sec-search-firm**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 } }),
		});
	});

	await page.goto('/dashboard');

	await page.getByPlaceholder('firm, person, CRD/SEC#').fill('Seon Lyndon Harry');
	await page.getByPlaceholder('firm, person, CRD/SEC#').press('Enter');

	const resultCard = page.locator('.searchResultsList .searchResultCard').filter({ hasText: 'Seon Lyndon Harry' });
	await expect(resultCard).toBeVisible();
	await resultCard.getByRole('button', { name: 'FINRA' }).click();

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 20_000,
			message: 'expected the dashboard click-through to navigate to the individual record path',
		})
		.toBe('/dashboard/individual/3102054');
	await expect
		.poll(async () => page.evaluate(() => window.location.search), {
			timeout: 20_000,
			message: 'expected the dashboard click-through to avoid query params in the main url',
		})
		.toBe('');

	await expect(page.locator('body')).toContainText('Seon Lyndon Harry');
	await expect(page.locator('body')).toContainText('Dashboard details');
});
