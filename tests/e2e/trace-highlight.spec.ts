import { expect, Page, test } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, resetBrowserGraphState } from './helpers/finra-e2e';

type TraceTargets = {
	sourceIndex: number;
	targetIndex: number;
};

async function synthesizeTouchDragClick(page: Page, selector: string) {
	await page.locator(selector).evaluate((button) => {
		const rect = button.getBoundingClientRect();
		const startX = rect.left + rect.width / 2;
		const startY = rect.top + rect.height / 2;
		const endX = startX + 18;
		const endY = startY + 18;

		if ('PointerEvent' in window) {
			const pointerInit = {
				bubbles: true,
				cancelable: true,
				composed: true,
				isPrimary: true,
				pointerId: 41,
				pointerType: 'touch',
			};
			button.dispatchEvent(new PointerEvent('pointerdown', { ...pointerInit, clientX: startX, clientY: startY }));
			button.dispatchEvent(new PointerEvent('pointermove', { ...pointerInit, clientX: endX, clientY: endY }));
			button.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, clientX: endX, clientY: endY }));
		}

		button.dispatchEvent(
			new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				composed: true,
				clientX: endX,
				clientY: endY,
			}),
		);
	});
}

async function getTraceTargets(page: Page): Promise<TraceTargets> {
	const traceTargets = await page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		const sourceIndex = nodes.findIndex((element) => /3102054|Seon Lyndon Harry/i.test(element.textContent || ''));
		const targetIndex = nodes.findIndex((element, index) => index !== sourceIndex && !/CRD:/i.test(element.textContent || '') && Boolean(element.textContent?.trim()));

		if (sourceIndex < 0 || targetIndex < 0) {
			return null;
		}

		return { sourceIndex, targetIndex };
	});

	if (!traceTargets) {
		throw new Error('Unable to derive trace targets from rendered graph data.');
	}

	return traceTargets;
}

test('Mobile sidebar controls ignore draggy touch gestures and Trace with Log still works', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const sidebar = page.locator('#fg-sidebar');
	const mobileMenuToggle = page.getByRole('button', { name: 'Toggle menu' });
	await expect(sidebar).toHaveClass(/hidden/);

	await synthesizeTouchDragClick(page, '#fg-mobile-menu-toggle');
	await expect(sidebar).toHaveClass(/hidden/);
	await page.waitForTimeout(300);

	await mobileMenuToggle.click();
	await expect(sidebar).not.toHaveClass(/hidden/);
	await mobileMenuToggle.click();
	await expect(sidebar).toHaveClass(/hidden/);

	const { sourceIndex, targetIndex } = await getTraceTargets(page);
	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	const targetNode = page.locator('.fg-node').nth(targetIndex);

	await sourceNode.click({ force: true });
	await expect(sidebar).not.toHaveClass(/hidden/);

	const infoToggle = page.getByRole('button', { name: 'Show info' });
	const traceModeToggle = page.locator('#fg-sidebar [data-fg-trace-mode-button="sidebar-mobile"]');
	await expect(infoToggle).toBeVisible();
	await expect(traceModeToggle).toBeVisible();
	await expect(infoToggle).toHaveAttribute('aria-pressed', 'false');
	await expect(traceModeToggle).toHaveAttribute('aria-pressed', 'false');

	await synthesizeTouchDragClick(page, '.fg-sidebar-mobile-summary-toggle');
	await synthesizeTouchDragClick(page, '#fg-sidebar [data-fg-trace-mode-button="sidebar-mobile"]');

	await expect(infoToggle).toHaveAttribute('aria-pressed', 'false');
	await expect(traceModeToggle).toHaveAttribute('aria-pressed', 'false');
	await targetNode.click({ force: true });
	const sidebarLogToggle = page.getByRole('button', { name: 'Show selection log' });
	await expect(sidebarLogToggle).toBeVisible();
	await expect(sidebarLogToggle).toHaveAttribute('aria-pressed', 'false');

	await synthesizeTouchDragClick(page, '.fg-sb-log-toggle');
	await expect(sidebarLogToggle).toHaveAttribute('aria-pressed', 'false');
	await page.waitForTimeout(300);

	await sidebarLogToggle.click();
	await expect(page.locator('#fg-sidebar-selection-log-list .fg-log-entry')).toHaveCount(2);

	await traceModeToggle.click();
	await expect(traceModeToggle).toHaveAttribute('aria-pressed', 'true');

	const sidebarTraceButton = page.locator('#fg-sidebar [data-fg-selection-log-action="trace"]').first();
	await expect(sidebarTraceButton).toBeVisible();
	await sidebarTraceButton.click();

	await expect(sidebarTraceButton).toHaveText('Log Trace On');
	await expect(sidebarTraceButton).toHaveAttribute('aria-pressed', 'true');
	await expect(sourceNode).toHaveClass(/trace-log/);
	await expect
		.poll(async () => page.locator('.fg-node.trace-log, .fg-node.trace-log-connector').count(), {
			timeout: 10_000,
			message: 'expected Trace with Log to highlight rendered graph nodes',
		})
		.toBeGreaterThan(1);
});
