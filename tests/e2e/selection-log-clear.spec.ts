import { expect, test } from '@playwright/test';

import { deterministicSelectionLogEntries, readStoredSelectionLog, seedStandaloneSelectionLog } from './helpers/finra-e2e';

test('Clear ind/firm empties the standalone selection log and persists the empty state', async ({ page }) => {
	await page.goto('/');
	await seedStandaloneSelectionLog(page, deterministicSelectionLogEntries);

	await page.reload();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(2);

	await page.evaluate(() => {
		const panel = document.getElementById('fg-selection-log');
		panel?.classList.remove('hidden');
	});
	await expect(page.locator('#fg-selection-log')).toBeVisible();

	await page.locator('#btn-selection-log-clear-ind').click();
	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(1);
	await page.locator('#btn-selection-log-clear-firm').click();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(0);
	await expect(page.locator('#fg-selection-log')).toBeVisible();
	await expect
		.poll(
			async () => {
				const storedLog = await readStoredSelectionLog(page);
				return Array.isArray(storedLog) ? storedLog.length : -1;
			},
			{
				timeout: 10_000,
				message: 'expected clear ind/firm actions to persist an empty selection log',
			},
		)
		.toBe(0);

	await page.reload();

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(0);
});
