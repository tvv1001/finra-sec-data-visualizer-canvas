import { expect, test, type Page } from '@playwright/test';
import { openGraphSideMenu, resetBrowserGraphState, seedStoredSession } from './helpers/finra-e2e';

test('Clear Highlight preserves dashboard route for selected node', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);

	// Seed a simple firm node and one connected person
	await seedStoredSession(page, {
		extraNodes: [
			{ id: 'firm:12345', label: 'Test Firm', group: 'firm', firmId: '12345' },
			{ id: 'person:999999', label: 'Test Person', group: 'individual', crd: '999999' },
		],
		extraLinks: [{ source: 'person:999999', target: 'firm:12345', relationship: 'employed_by', isCurrent: true }],
	});

	await page.reload();

	// Click the firm node
	const firmNode = page.locator('.fg-node').filter({ hasText: 'Test Firm' }).first();
	await expect(firmNode).toHaveCount(1);
	await firmNode.click({ force: true });

	// Wait for sidebar and pathname to update to dashboard/firm/12345
	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect.poll(async () => page.evaluate(() => window.location.pathname), { timeout: 5000 }).toBe('/firm/12345');

	// Click Clear Highlight button
	const clearBtn = page.locator('[data-fg-action="clear-highlights"]');
	await expect(clearBtn).toHaveCount(1);
	await clearBtn.click({ force: true });

	// URL should remain the same
	await expect(page.evaluate(() => window.location.pathname)).resolves.toBe('/firm/12345');
});
