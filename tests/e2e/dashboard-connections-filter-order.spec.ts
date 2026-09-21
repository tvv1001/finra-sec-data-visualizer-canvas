import { expect, test } from '@playwright/test';

const firmConnections = [
	{ individualId: '1', name: 'Alice Smith', isCurrent: true, relationship: 'Current registration' },
	{ individualId: '2', name: 'Bob Jones', isCurrent: true, relationship: 'Current registration' },
	{ individualId: '3', name: 'Carol Smith', isCurrent: true, relationship: 'Current registration' },
];

const firmPayload = {
	basicInformation: { firmId: '143571', firmName: 'Regression Firm Two' },
	firmId: '143571',
	firmName: 'Regression Firm Two',
	hasFinraData: true,
};

test('firm connection keyword filter keeps unmatched cards below matches; Select all only matched', async ({ page }) => {
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 }, results: [] }),
		});
	});

	await page.route('**/api/finra/firm/143571**', async (route) => {
		const url = route.request().url();
		if (url.includes('/connections')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					found: true,
					firmId: '143571',
					currentConnections: firmConnections,
					previousConnections: [],
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				found: true,
				hasFinraData: true,
				sources: {
					finra: { content: firmPayload },
				},
				merged: firmPayload,
				finraNode: firmPayload,
			}),
		});
	});

	await page.route('**/api/finra/expand/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ nodes: [], links: [] }),
		});
	});

	await page.addInitScript(() => {
		localStorage.setItem('finra_connections_filter_enabled', '1');
		localStorage.setItem('finra_connections_filter_tags', JSON.stringify(['smith']));
		localStorage.setItem('finra_connections_filter_text', '');
	});

	await page.goto('/dashboard/firm/143571');
	await expect(page.getByText('Current Connections', { exact: false })).toBeVisible({ timeout: 20_000 });

	await expect
		.poll(async () => {
			const texts = await page.locator('[class*="currentConnectionName"]').allTextContents();
			return texts.map((t) => t.trim()).filter((t) => /Alice Smith|Bob Jones|Carol Smith/.test(t));
		})
		.toEqual(['Alice Smith', 'Carol Smith', 'Bob Jones']);

	await page.getByRole('button', { name: 'Select mode' }).click();
	await page.getByRole('button', { name: 'Select all' }).click();

	const checked = page.locator('button[class*="connectionSelectRow"] input[type="checkbox"]:checked');
	await expect(checked).toHaveCount(2);
	await expect(page.getByRole('button', { name: /Done \(2\)/ })).toBeVisible();
	await expect(page.getByText('Bob Jones')).toBeVisible();
});
