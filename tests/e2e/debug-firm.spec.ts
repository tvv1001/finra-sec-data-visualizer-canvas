import { test } from '@playwright/test';

test('debug firm 18387 sidebar', async ({ page }) => {
	await page.goto('https://finra-data-chart-next-02.vercel.app/firm/18387', { waitUntil: 'networkidle' });
	// Wait up to 10s for sidebar to be rendered by client
	await page.waitForFunction(() => (window as any).__FG_SIDEBAR_RENDERED === true, { timeout: 10000 }).catch(() => {});
	const displayedId = await page.evaluate(() => document.getElementById('fg-sidebar')?.dataset.displayedId || null);
	const sidebarHtml = await page.evaluate(() => document.getElementById('fg-sidebar-inner')?.innerText || document.getElementById('fg-sidebar')?.innerText || '');
	console.log('displayedId=', displayedId);
	console.log('sidebarHtmlSnippet=', sidebarHtml.slice(0, 800));
});
