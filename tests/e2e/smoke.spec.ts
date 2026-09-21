import { expect, test } from '@playwright/test';

test('loads the core graph shell', async ({ page }) => {
	await page.goto('/');

	await expect(page.locator('#finra-app')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'FINRA' })).toBeVisible();
	await expect(page.locator('#fg-fetch-input')).toBeVisible();
	await expect(page.locator('#fg-database-search')).toBeVisible();
	await expect(page.locator('#fg-svg')).toBeVisible();
	await expect(page.locator('#fg-main')).toBeVisible();
});

test('FDA lookup route returns structured JSON instead of a missing-route 404', async ({ request }) => {
	const response = await request.get('/api/finra/fda/TEST-DOCKET-123');
	expect(response.status()).toBe(200);

	const payload = await response.json();
	expect(payload.docket).toBe('TEST-DOCKET-123');
	expect(typeof payload.found).toBe('boolean');
	expect(typeof payload.blocked).toBe('boolean');
	expect(typeof payload.noResults).toBe('boolean');
	expect(typeof payload.upstreamStatus).toBe('number');
	expect(typeof payload.node?.data?.attributes?.body?.value).toBe('string');
	expect(String(payload.node?.data?.attributes?.body?.value || '')).toContain('TEST-DOCKET-123');
	await expect(response).toBeOK();
});

test('prime-check exposes FDA summary fields on the single cron endpoint', async ({ request }) => {
	const response = await request.get('/api/finra/prime-check?limit=1&concurrency=1');
	expect(response.status()).toBe(200);

	const payload = await response.json();
	expect(payload.ok).toBe(true);
	expect(payload.mode).toBe('daily-usage-aware-prime-check');
	expect(typeof payload.results?.warmedIndividuals).toBe('number');
	expect(typeof payload.results?.warmedFirms).toBe('number');
	expect(typeof payload.results?.fdaChecks?.individualsScanned).toBe('number');
	expect(typeof payload.results?.fdaChecks?.docketsQueued).toBe('number');
	expect(typeof payload.results?.fdaChecks?.docketsChecked).toBe('number');
	expect(typeof payload.results?.fdaChecks?.found).toBe('number');
	expect(typeof payload.results?.fdaChecks?.blocked).toBe('number');
	expect(typeof payload.results?.fdaChecks?.noResults).toBe('number');
	expect(Array.isArray(payload.results?.fdaChecks?.failures)).toBe(true);
	await expect(response).toBeOK();
});
