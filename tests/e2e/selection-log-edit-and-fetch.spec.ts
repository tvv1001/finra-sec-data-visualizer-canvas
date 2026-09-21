import { expect, test } from '@playwright/test';
import { seedStandaloneSelectionLog } from './helpers/finra-e2e';

test.describe('Selection Log - Edit Node Removal and Auto-Fetch', () => {
	test('when in edit mode, closing a node in the log removes that node and its connections from the graph', async ({ page }) => {
		await page.goto('/');

		// 1. Seed selection log with test nodes
		await seedStandaloneSelectionLog(page, [
			{
				id: 'person:4098470',
				label: 'Test Person',
				secondaryId: 'CRD# 4098470',
				group: 'individual',
			},
		]);

		await page.reload();

		// Wait for the log entry to appear to ensure page is compiled & loaded
		await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(1, { timeout: 60000 });

		// 2. Open Selection Log panel
		await page.evaluate(() => {
			const button = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
			button?.click();
		});
		await expect(page.locator('#fg-selection-log')).toBeVisible();

		// 3. Since graph is empty of this node, click to fetch it first so it is on the screen
		await page.locator('#fg-selection-log-list .fg-log-text').click();

		// Verify the node is on the screen (displayed count > 0)
		await expect(page.locator('#fg-bottom-status')).toContainText('Displayed: 1 People', { timeout: 20000 });

		// 4. Enter edit mode
		await page.locator('[data-fg-selection-log-action="edit"]').click();
		await expect(page.locator('[data-fg-selection-log-action="edit"]')).toHaveAttribute('aria-pressed', 'true');

		// 5. Close/remove the node in the log
		await page.locator('#fg-selection-log-list .fg-log-item-action-btn.is-delete').click();

		// 6. Verify the node is removed from the selection log and from the screen
		await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(0);
		await expect(page.locator('#fg-bottom-status')).toContainText('Displayed: 0 People');
	});

	test('when clicking a node log item to copy, if that node is not on screen, it is fetched', async ({ page }) => {
		await page.goto('/');

		// 1. Seed selection log with a node that is not in the graph
		await seedStandaloneSelectionLog(page, [
			{
				id: 'person:4098470',
				label: 'Test Person',
				secondaryId: 'CRD# 4098470',
				group: 'individual',
			},
		]);

		await page.reload();

		// Wait for the log entry to appear to ensure page is compiled & loaded
		await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(1, { timeout: 60000 });

		// 2. Open Selection Log panel
		await page.evaluate(() => {
			const button = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
			button?.click();
		});
		await expect(page.locator('#fg-selection-log')).toBeVisible();

		// 3. Click the log item text to trigger the copy and auto-fetch
		await page.locator('#fg-selection-log-list .fg-log-text').click();

		// 4. Verify that the node is fetched and now displayed on the screen
		await expect
			.poll(
				async () => {
					const text = await page.locator('#fg-bottom-status').textContent();
					return text || '';
				},
				{
					timeout: 20_000,
					message: 'expected node to be fetched and displayed on screen',
				},
			)
			.toContain('Displayed: 1 People');
	});
});
