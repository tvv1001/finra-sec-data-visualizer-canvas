import { expect, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState } from './helpers/finra-e2e';

test('Toggle menu opens and closes the sidebar shell', async ({ page }) => {
	await page.goto('/');

	const app = page.locator('#finra-app');
	const sidebar = page.locator('#fg-sidebar');
	const backdrop = page.locator('#fg-sidebar-backdrop');
	const toggleMenuButton = page.getByRole('button', { name: 'Toggle menu' });

	await expect(sidebar).toHaveClass(/hidden/);
	await expect(backdrop).toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'false');

	await toggleMenuButton.click();

	await expect(sidebar).not.toHaveClass(/hidden/);
	await expect(backdrop).not.toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'true');
	await expect(page.getByRole('button', { name: 'Reset Session' })).toBeVisible();

	// Menu does not auto-hide on Escape — only the hamburger toggle closes it.
	await page.keyboard.press('Escape');
	await expect(sidebar).not.toHaveClass(/hidden/);

	await toggleMenuButton.click();

	await expect(sidebar).toHaveClass(/hidden/);
	await expect(backdrop).toHaveClass(/hidden/);
	await expect(app).toHaveAttribute('data-sidebar-open', 'false');
});

test('Center keeps the selected mobile node below the collapsed menu chrome', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const sourceIndex = await page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		return nodes.findIndex((element) => /3102054|Seon Lyndon Harry/i.test(element.textContent || ''));
	});
	if (sourceIndex < 0) {
		throw new Error('Unable to find mobile focus target node.');
	}

	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	await sourceNode.click({ force: true });
	// Node select keeps the hamburger menu closed; details load only when it opens.
	await expect(page.locator('#fg-sidebar')).toHaveClass(/hidden/);

	await page.getByRole('button', { name: 'Toggle menu' }).click();
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);

	const focusButton = page.getByRole('button', { name: 'Center on this node' });
	await expect(focusButton).toBeVisible();
	await focusButton.click();
	await page.waitForTimeout(750);

	const metrics = await page.evaluate(() => {
		const selectedNode = document.querySelector<SVGGElement>('.fg-node.selected');
		const main = document.getElementById('fg-main');
		const mobileActions = document.querySelector<HTMLElement>('.fg-sidebar-mobile-actions');
		if (!selectedNode || !main || !mobileActions) return null;

		const nodeRect = selectedNode.getBoundingClientRect();
		const mainRect = main.getBoundingClientRect();
		const actionsRect = mobileActions.getBoundingClientRect();
		const safeTop = Math.max(mainRect.top, actionsRect.bottom);

		return {
			nodeCenterY: nodeRect.top + nodeRect.height / 2,
			actionsBottom: actionsRect.bottom,
			safeCenterY: safeTop + (mainRect.bottom - safeTop) / 2,
		};
	});

	expect(metrics).not.toBeNull();
	if (!metrics) return;

	expect(metrics.nodeCenterY).toBeGreaterThan(metrics.actionsBottom + 8);
	expect(Math.abs(metrics.nodeCenterY - metrics.safeCenterY)).toBeLessThan(90);
});

test('Center keeps the normal viewport center when the mobile menu is fully expanded', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const sourceIndex = await page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		return nodes.findIndex((element) => /3102054|Seon Lyndon Harry/i.test(element.textContent || ''));
	});
	if (sourceIndex < 0) {
		throw new Error('Unable to find expanded mobile focus target node.');
	}

	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	await sourceNode.click({ force: true });
	await expect(page.locator('#fg-sidebar')).toHaveClass(/hidden/);

	await page.getByRole('button', { name: 'Toggle menu' }).click();
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);

	const infoToggle = page.getByRole('button', { name: 'Show info' });
	await expect(infoToggle).toBeVisible();
	await infoToggle.click();
	await expect(infoToggle).toHaveAttribute('aria-pressed', 'true');

	const focusButton = page.getByRole('button', { name: 'Center on this node' });
	await expect(focusButton).toBeVisible();
	await focusButton.click();
	await page.waitForTimeout(750);

	const metrics = await page.evaluate(() => {
		const selectedNode = document.querySelector<SVGGElement>('.fg-node.selected');
		const main = document.getElementById('fg-main');
		const sidebar = document.getElementById('fg-sidebar');
		if (!selectedNode || !main || !sidebar) return null;

		const nodeRect = selectedNode.getBoundingClientRect();
		const mainRect = main.getBoundingClientRect();

		return {
			nodeCenterY: nodeRect.top + nodeRect.height / 2,
			mainCenterY: mainRect.top + mainRect.height / 2,
			mobileExpanded: sidebar.getAttribute('data-mobile-expanded'),
		};
	});

	expect(metrics).not.toBeNull();
	if (!metrics) return;

	expect(metrics.mobileExpanded).toBe('true');
	expect(Math.abs(metrics.nodeCenterY - metrics.mainCenterY)).toBeLessThan(90);
});
