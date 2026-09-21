import { defineConfig } from '@playwright/test';

const PORT = 4444;
// Prefer localhost over 127.0.0.1 so Next.js 16 dev resource checks
// (allowedDevOrigins / HMR) do not block client hydration in Playwright.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 45_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 2 : 1,
	reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL,
		headless: true,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},
	webServer: {
		// Ensure the Next dev server started for tests disables external FINRA/SEC calls
		// to avoid hitting upstream rate limits during deterministic e2e runs.
		command: 'EXTERNAL_API_DISABLED=1 pnpm dev',
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
