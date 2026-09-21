import { expect, test, type Page } from '@playwright/test';

import { deterministicSelectionLogEntries, readStoredSessionState, seedStandaloneSelectionLog } from './helpers/finra-e2e';

async function waitForGraphShell(page: Page) {
	await expect(page.locator('#fg-main')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('#btn-selection-log-trace')).toBeAttached({ timeout: 30_000 });
	await expect(page.getByText('Loading graph…')).toHaveCount(0, { timeout: 30_000 });
}

async function openStandaloneSelectionLog(page: Page) {
	await page.evaluate(() => {
		const button = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
		button?.click();
	});
	await expect(page.locator('#btn-selection-log-trace')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('#fg-selection-log')).toBeVisible();
	await expect(page.locator('#fg-selection-log')).not.toHaveClass(/hidden/);
}

test('Saved Templates toggle can store a graph snapshot that survives Reset Session', async ({ page }) => {
	await page.goto('/');
	await waitForGraphShell(page);

	await page.evaluate(() => {
		localStorage.removeItem('finra_graph_templates');
	});
	await seedStandaloneSelectionLog(page, deterministicSelectionLogEntries);
	await page.reload();
	await waitForGraphShell(page);

	await expect(page.locator('#fg-selection-log-list .fg-log-entry')).toHaveCount(2);
	await openStandaloneSelectionLog(page);

	const templatesHost = page.locator('#fg-selection-log-templates');
	await expect(templatesHost).toBeVisible();
	await expect(templatesHost.getByRole('button', { name: 'Save Template' })).toBeVisible();

	await templatesHost.getByRole('button', { name: 'Save Template' }).click();
	await expect(templatesHost.locator('.fg-template-row')).toHaveCount(1);

	const autoName = await templatesHost.locator('.fg-template-name-input').inputValue();
	expect(autoName.trim().length).toBeGreaterThan(0);

	await templatesHost.locator('.fg-template-name-input').fill('Regression Snapshot');
	await templatesHost.locator('.fg-template-name-input').blur();
	await expect(templatesHost.locator('.fg-template-name-input')).toHaveValue('Regression Snapshot');

	const storedBeforeReset = await page.evaluate(() => {
		const raw = localStorage.getItem('finra_graph_templates');
		return raw ? JSON.parse(raw) : null;
	});
	expect(Array.isArray(storedBeforeReset)).toBe(true);
	expect(storedBeforeReset?.[0]?.name).toBe('Regression Snapshot');
	expect(Array.isArray(storedBeforeReset?.[0]?.selectionLog)).toBe(true);
	expect(storedBeforeReset?.[0]?.selectionLog?.map((entry: { id?: string }) => entry?.id)).toEqual(deterministicSelectionLogEntries.map((entry) => entry.id));

	// Close the floating selection-log panel so it cannot intercept menu clicks.
	await page.evaluate(() => {
		const button = document.getElementById('btn-selection-log-trace') as HTMLButtonElement | null;
		button?.click();
	});
	await expect(page.locator('#btn-selection-log-trace')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('#fg-selection-log')).toHaveClass(/hidden/);

	await page.getByRole('button', { name: 'Toggle menu' }).click();
	const resetButton = page.getByRole('button', { name: 'Reset Session' });
	await expect(resetButton).toBeVisible();
	await resetButton.click();
	await expect
		.poll(async () => readStoredSessionState(page), {
			timeout: 10_000,
			message: 'expected Reset Session to clear the active session',
		})
		.toMatchObject({ cleared: true });

	const storedAfterReset = await page.evaluate(() => {
		const raw = localStorage.getItem('finra_graph_templates');
		return raw ? JSON.parse(raw) : null;
	});
	expect(storedAfterReset?.[0]?.name).toBe('Regression Snapshot');

	// Clear the live selection log so Load has a visible effect after reset.
	await page.evaluate(() => {
		localStorage.setItem('finra_selection_log', JSON.stringify([]));
	});
	await page.reload();
	await waitForGraphShell(page);
	await openStandaloneSelectionLog(page);

	// Templates list starts collapsed after a fresh shell load.
	const templatesToggle = templatesHost.getByRole('button', { name: /Saved Templates/i });
	await expect(templatesToggle).toBeVisible();
	if ((await templatesToggle.getAttribute('aria-expanded')) !== 'true') {
		await templatesToggle.click();
	}
	await expect(templatesToggle).toHaveAttribute('aria-expanded', 'true');
	await expect(templatesHost.locator('.fg-template-name-input')).toHaveValue('Regression Snapshot');

	await templatesHost.getByRole('button', { name: 'Load' }).click();
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('finra_selection_log');
					const log = raw ? JSON.parse(raw) : [];
					return Array.isArray(log) ? log.map((entry: { id?: string }) => entry?.id).filter(Boolean) : [];
				}),
			{
				timeout: 15_000,
				message: 'expected loading a template to restore the selection log entries',
			},
		)
		.toEqual(deterministicSelectionLogEntries.map((entry) => entry.id));
});
