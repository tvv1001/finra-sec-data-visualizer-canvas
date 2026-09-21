import { expect, test, type Page } from '@playwright/test';

import { resetBrowserGraphState } from './helpers/finra-e2e';

const INDIVIDUAL_HIT = {
	_source: {
		ind_source_id: '9999001',
		ind_crd: '9999001',
		ind_firstname: 'Toggle',
		ind_middlename: '',
		ind_lastname: 'Person',
		ind_bc_scope: 'Active',
	},
};

const FIRM_HIT = {
	_source: {
		firm_id: '9999002',
		firm_source_id: '9999002',
		firm_name: 'Toggle Firm Inc',
	},
};

async function mockSearchEndpoints(page: Page) {
	await page.route('**/api/finra/search**', async (route) => {
		const url = new URL(route.request().url());
		const isFirmRequest = url.searchParams.get('firm') === '1';
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: {
					total: 1,
					hits: [isFirmRequest ? FIRM_HIT : INDIVIDUAL_HIT],
				},
			}),
		});
	});

	await page.route('**/api/finra/sec-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { total: 0, hits: [] } }),
		});
	});
}

async function runHeaderSearch(page: Page, query: string, type: 'all' | 'people' | 'firms') {
	await page.locator('#fg-search-type').selectOption(type);
	const fetchInput = page.locator('#fg-fetch-input');
	await fetchInput.fill(query);
	await page.locator('#fg-database-search').click();
	await expect(page.locator('#fg-database-search')).toBeEnabled({ timeout: 10_000 });
}

test.describe('Header search type toggle (All / People / Firms)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await resetBrowserGraphState(page);
		await page.reload();
		await mockSearchEndpoints(page);
	});

	test('People filters out firm hits', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'people');

		await expect
			.poll(async () => page.locator('.fg-node--individual', { hasText: 'Toggle Person' }).count(), {
				timeout: 10_000,
				message: 'expected the individual hit to render as a node when filtering to People',
			})
			.toBeGreaterThan(0);

		expect(await page.locator('.fg-node--firm', { hasText: 'Toggle Firm Inc' }).count()).toBe(0);
	});

	test('Firms filters out people hits', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'firms');

		await expect
			.poll(async () => page.locator('.fg-node--firm', { hasText: 'Toggle Firm Inc' }).count(), {
				timeout: 10_000,
				message: 'expected the firm hit to render as a node when filtering to Firms',
			})
			.toBeGreaterThan(0);

		expect(await page.locator('.fg-node--individual', { hasText: 'Toggle Person' }).count()).toBe(0);
	});

	test('All shows both people and firm hits', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'all');

		await expect
			.poll(async () => page.locator('.fg-node--individual', { hasText: 'Toggle Person' }).count(), {
				timeout: 10_000,
				message: 'expected the individual hit to render when search type is All',
			})
			.toBeGreaterThan(0);

		await expect
			.poll(async () => page.locator('.fg-node--firm', { hasText: 'Toggle Firm Inc' }).count(), {
				timeout: 10_000,
				message: 'expected the firm hit to render when search type is All',
			})
			.toBeGreaterThan(0);
	});

	test('Selected search type persists across reload', async ({ page }) => {
		await page.locator('#fg-search-type').selectOption('firms');
		await expect(page.locator('#fg-search-type')).toHaveValue('firms');

		await page.reload();

		await expect(page.locator('#fg-search-type')).toHaveValue('firms');
	});
});
