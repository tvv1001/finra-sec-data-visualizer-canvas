const puppeteer = require('puppeteer');

async function run() {
	const PERSON_CRD = process.env.PERSON_CRD || '5294697';
	const TARGET_CRD = process.env.TARGET_CRD || PERSON_CRD;
	const base = process.env.APP_BASE || 'http://localhost:4444';

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
	const page = await browser.newPage();
	// allow more time for navigation on slower dev servers
	page.setDefaultTimeout(30000);
	page.setDefaultNavigationTimeout(60000);

	try {
		// Try opening the node-specific route first (if available)
		const nodeUrl = `${base}/node/person-${PERSON_CRD}`;
		console.log('Navigating to', nodeUrl);
		try {
			await page.goto(nodeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
		} catch (navErr) {
			console.warn('Node route navigation failed, falling back to base page:', navErr.message || navErr);
			await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
		}

		// Wait for the client graph to initialize (Pixi/global nodes) before dispatching route event
		try {
			await page.waitForFunction(
				() => {
					// eslint-disable-next-line no-undef
					return typeof window !== 'undefined' && !!(window.__FINRA_GRAPH_NODES && window.__FINRA_GRAPH_NODES.length);
				},
				{ timeout: 20000 },
			);
		} catch (e) {
			// continue even if the global flag isn't set
		}

		// Dispatch the route request event to ensure the client hydrates and fetches the profile
		try {
			await page.evaluate((pid) => {
				try {
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { nodeId: `person:${pid}` } }));
				} catch (e) {
					// ignore
				}
			}, PERSON_CRD);
		} catch (e) {
			// ignore evaluation errors
		}

		// Ensure the sidebar info panel is expanded (some content is hidden behind the "Info" toggle)
		try {
			const infoToggle = await page.$('.fg-sb-toggle-btn.fg-sb-info-toggle');
			if (infoToggle) {
				await infoToggle.click();
				// wait a moment for content to reveal
				try {
					await page.waitForSelector('.fg-tl-entry', { timeout: 5000 });
				} catch (e) {
					// ignore - entries may not exist
				}
			}
		} catch (e) {
			// ignore
		}

		const selector = `.fg-crd-link[data-crd="${TARGET_CRD}"]`;
		console.log('Checking for selector', selector);

		// Wait for client-side sidebar render flag if available
		try {
			await page.waitForFunction(
				() => {
					// eslint-disable-next-line no-undef
					return typeof window !== 'undefined' && window.__FG_SIDEBAR_RENDERED === true;
				},
				{ timeout: 10000 },
			);
		} catch (e) {
			// continue even if flag not set
		}
		const found = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
		console.log('Selector count:', found);
		if (found === 0) {
			console.warn('Selector not found; listing other .fg-crd-link entries for debugging');
			const others = await page.$$eval('.fg-crd-link', (els) => els.map((e) => ({ crd: e.getAttribute('data-crd'), text: e.textContent && e.textContent.trim() })));
			try {
				const sidebarHtml = await page.$eval('#fg-sidebar-inner', (el) => el.innerHTML);
				console.warn('Sidebar innerHTML snapshot:\n', sidebarHtml.slice(0, 2000));
			} catch (e) {
				console.warn('Failed to read sidebar innerHTML:', e && e.message ? e.message : e);
			}
			try {
				const sidebarHtml = await page.$eval('#fg-sidebar-inner', (el) => el.innerHTML);
				const match = sidebarHtml.match(/(.{0,120}GAR WOOD.{0,120})/i);
				if (match) console.warn('GAR WOOD context:', match[1]);
			} catch (e) {
				// ignore
			}
			try {
				const entries = await page.$$eval('.fg-tl-entry', (els) => els.slice(0, 8).map((el) => el.outerHTML));
				console.warn('Timeline entries sample:', entries.join('\n---\n'));
			} catch (e) {
				// ignore
			}
			try {
				const meta = await page.$eval('#fg-sidebar-inner', (el) => ({
					length: el.innerHTML.length,
					hasGarwood: el.innerHTML.includes('GAR WOOD'),
					hasEmployment: el.innerHTML.includes('Employment'),
				}));
				console.warn('Sidebar meta:', JSON.stringify(meta, null, 2));
			} catch (e) {
				// ignore
			}
			console.log('Other fg-crd-link entries:', JSON.stringify(others, null, 2));

			// Try fallback: locate firm name in timeline entries and click that instead
			let firmName = null;
			try {
				firmName = await page.evaluate(
					async (fid, baseUrl) => {
						try {
							const r = await fetch(`${baseUrl}/api/finra/firm/${fid}`);
							if (!r.ok) return null;
							const j = await r.json();
							return j?.firmName || j?.basicInformation?.firmName || null;
						} catch (e) {
							return null;
						}
					},
					TARGET_CRD,
					base,
				);
			} catch (e) {
				// ignore
			}

			if (firmName) {
				console.log('Attempting fallback click by firm name:', firmName);
				const matched = await page.$$eval(
					'.fg-tl-firm',
					(els, name) => {
						const el = els.find((e) => (e.textContent || '').toLowerCase().includes(name.toLowerCase()));
						if (!el) return false;
						el.click();
						return true;
					},
					firmName,
				);
				if (matched) {
					console.log('Fallback: clicked firm name span');
					// wait for sidebar title
					try {
						await page.waitForSelector('#fg-sidebar-inner .fg-sb-title', { timeout: 5000 });
						const title = await page.$eval('#fg-sidebar-inner .fg-sb-title', (el) => el.textContent && el.textContent.trim());
						console.log('Sidebar title (fallback):', title);
						console.log('Success: fallback click complete');
						await browser.close();
						return;
					} catch (e) {
						console.warn('Fallback did not navigate to sidebar title in time');
					}
				}
			}

			throw new Error('Selector not found on page');
		}

		console.log('Clicking CRD button');
		await page.click(selector);

		// Wait for sidebar to show title
		const titleSel = '#fg-sidebar-inner .fg-sb-title';
		await page.waitForSelector(titleSel, { timeout: 5000 });
		const title = await page.$eval(titleSel, (el) => el.textContent && el.textContent.trim());
		console.log('Sidebar title:', title);

		console.log('Success: CRD click complete');
	} catch (err) {
		console.error('Test failed:', err && err.message ? err.message : err);
		process.exitCode = 2;
	} finally {
		await browser.close();
	}
}

run();
