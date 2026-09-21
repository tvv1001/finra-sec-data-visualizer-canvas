import { expect, test } from '@playwright/test';

test('location toggle stays disabled until the fetch query has at least 3 characters', async ({ page }) => {
	await page.goto('/');

	const fetchInput = page.locator('#fg-fetch-input');
	const locationToggle = page.locator('.fg-fetch-toggle');
	const locationPanel = page.locator('#fg-location-panel');
	const locationInput = page.locator('#fg-loc-input');

	await expect(fetchInput).toBeVisible();
	await expect(locationToggle).toBeDisabled();

	await fetchInput.fill('San');
	await expect(locationToggle).toBeEnabled();

	await locationToggle.click();
	await expect(locationToggle).toHaveAttribute('aria-expanded', 'true');
	await expect(locationPanel).toBeVisible();
	await expect(locationInput).toHaveValue('');
});
