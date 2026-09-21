import { expect, test } from '@playwright/test';

import { deterministicSelectionLogEntries, seedStandaloneSelectionLog } from './helpers/finra-e2e';

test('Trace with Log shows the standalone selection-log panel from persisted log state', async ({ page }) => {
	await page.goto('/');
	await seedStandaloneSelectionLog(page, deterministicSelectionLogEntries);

	await page.reload();

	await expect(page.locator('#fg-sidebar')).toHaveClass(/hidden/);
	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(2);
	await expect(page.locator('#fg-selection-log-list')).toContainText('Regression Person One');
	await expect(page.locator('#fg-selection-log-list')).toContainText('Regression Firm Two');

	const traceLogButton = page.locator('#btn-selection-log-trace');
	await page.evaluate(() => {
		const button = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
		button?.click();
	});

	await expect(traceLogButton).toHaveText('Log Trace On');
	await expect(traceLogButton).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('#fg-selection-log')).toBeVisible();
	await expect(page.locator('#fg-selection-log')).not.toHaveClass(/hidden/);
	await expect(page.locator('#fg-selection-log h3')).toHaveText('Selection Log');
});
