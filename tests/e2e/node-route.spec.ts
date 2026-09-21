import { expect, test, type Page } from '@playwright/test';

import { fetchGraphQueryWithLinkedResults, openGraphSideMenu, resetBrowserGraphState, seedStoredSession } from './helpers/finra-e2e';

async function getRenderedNodeIndex(page: Page, matcher: RegExp) {
	const index = await page.evaluate((patternSource) => {
		const pattern = new RegExp(patternSource, 'i');
		const nodes = Array.from(document.querySelectorAll<Element>('.fg-node'));
		return nodes.findIndex((element) => pattern.test(element.textContent || ''));
	}, matcher.source);
	if (index < 0) {
		throw new Error(`Unable to find rendered node matching ${matcher}.`);
	}
	return index;
}

test('Selecting a node pushes an analytics-friendly node route', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.reload();

	await fetchGraphQueryWithLinkedResults(page, '3102054');

	const sourceIndex = await getRenderedNodeIndex(page, /3102054|Seon Lyndon Harry/);
	const sourceNode = page.locator('.fg-node').nth(sourceIndex);
	await sourceNode.click({ force: true });

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 10_000,
			message: 'expected selecting a node to push a /individual/... route',
		})
		.toBe('/individual/3102054');
});

test('Selecting a node also marks visible hop-connected neighbors as selected', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:3102054',
				label: 'Hop Source Person',
				group: 'individual',
				crd: '3102054',
			},
			{
				id: 'firm:143571',
				label: 'Hop Neighbor Firm',
				group: 'firm',
				firmId: '143571',
			},
		],
		extraLinks: [
			{
				source: 'person:3102054',
				target: 'firm:143571',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
	});
	await page.reload();

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded two-node graph to render before testing hop selection',
		})
		.toBe(2);

	const sourceNode = page.locator('.fg-node').filter({ hasText: 'Hop Source Person' });
	const connectedNode = page.locator('.fg-node').filter({ hasText: 'Hop Neighbor Firm' });
	await expect(sourceNode).toHaveCount(1);
	await expect(connectedNode).toHaveCount(1);

	await sourceNode.click({ force: true });

	await expect(sourceNode).toHaveClass(/selected/);
	await expect(connectedNode).toHaveClass(/selected/);
	await expect(connectedNode).toHaveClass(/highlighted-hop/);
});

test('Fetched nodes with zero child links render as selected automatically', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:999111',
				label: 'Leaf Fetch',
				group: 'individual',
				crd: '999111',
				basicInformation: {
					individualId: '999111',
					firstName: 'Leaf',
					lastName: 'Fetch',
				},
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				currentEmployments: [],
				currentIAEmployments: [],
				previousEmployments: [],
				previousIAEmployments: [],
				_detailLoaded: true,
				_trustedCurrentRelationshipData: true,
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const fetchedLeafNode = page.locator('.fg-node').filter({ hasText: 'Leaf Fetch' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded fetched leaf node to render before asserting auto-selection',
		})
		.toBe(1);
	await expect(fetchedLeafNode).toHaveCount(1);
	await expect(fetchedLeafNode).toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
});

test('Fetched inactive nodes with hidden previous relationships do not auto-select as leaves', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:2171408',
				label: 'Ronald Perry Mason',
				group: 'individual',
				crd: '2171408',
				bcScope: 'InActive',
				basicInformation: {
					individualId: '2171408',
					firstName: 'Ronald',
					middleName: 'Perry',
					lastName: 'Mason',
					bcScope: 'InActive',
				},
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				currentEmployments: [],
				currentIAEmployments: [],
				previousEmployments: [{ firmId: '13686', firmName: 'H.D. VEST INVESTMENT SERVICES' }],
				_detailLoaded: true,
				_trustedCurrentRelationshipData: true,
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const inactiveHistoricalNode = page.locator('.fg-node').filter({ hasText: 'Ronald Perry Mason' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the inactive Mason regression node to render before asserting leaf-selection behavior',
		})
		.toBe(1);
	await expect(inactiveHistoricalNode).toHaveCount(1);
	await expect(inactiveHistoricalNode).toHaveClass(/fg-node--inactive/);
	await expect(inactiveHistoricalNode).not.toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
});

test('Fetched connected nodes render as selected when all trusted current relationships are already visible', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:143571',
				label: 'Trusted Visible Firm',
				group: 'firm',
				firmId: '143571',
			},
			{
				id: 'person:999113',
				label: 'Trusted Connected Fetch',
				group: 'individual',
				crd: '999113',
				basicInformation: {
					individualId: '999113',
					firstName: 'Trusted',
					lastName: 'Connected Fetch',
				},
				registrationCount: {
					approvedFinraRegistrationCount: 1,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				currentEmployments: [{ firmId: '143571', firmName: 'Trusted Visible Firm' }],
				currentIAEmployments: [],
				previousEmployments: [],
				previousIAEmployments: [],
				_detailLoaded: true,
				_trustedCurrentRelationshipData: true,
			},
		],
		extraLinks: [
			{
				source: 'person:999113',
				target: 'firm:143571',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
	});
	await page.reload();

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded connected fetched graph to render before asserting trusted exhaustion selection',
		})
		.toBe(2);

	const connectedFetchedNode = page.locator('.fg-node').filter({ hasText: 'Trusted Connected Fetch' });
	await expect(connectedFetchedNode).toHaveCount(1);
	await expect(connectedFetchedNode).toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(1);
});

test('Fetched connected nodes without trusted current relationship data do not auto-select', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:143572',
				label: 'Partial Visible Firm',
				group: 'firm',
				firmId: '143572',
			},
			{
				id: 'person:999114',
				label: 'Partial Connected Fetch',
				group: 'individual',
				crd: '999114',
			},
		],
		extraLinks: [
			{
				source: 'person:999114',
				target: 'firm:143572',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
	});
	await page.reload();

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded partial connected graph to render before asserting no auto-selection',
		})
		.toBe(2);

	const partialConnectedNode = page.locator('.fg-node').filter({ hasText: 'Partial Connected Fetch' });
	await expect(partialConnectedNode).toHaveCount(1);
	await expect(partialConnectedNode).not.toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(1);
});

test('Fetched firms do not auto-select until their revealable child count is known', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:555001',
				label: 'Unknown Child Count Firm',
				group: 'firm',
				firmId: '555001',
				_detailLoaded: true,
				_detailValidated: true,
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const fetchedFirmNode = page.locator('.fg-node').filter({ hasText: 'Unknown Child Count Firm' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the fetched firm node to render before asserting child-count gating',
		})
		.toBe(1);
	await expect(fetchedFirmNode).toHaveCount(1);
	await expect(fetchedFirmNode).not.toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
});

test('Direct route firm 314694 auto-selects when all graph-derived current connections are visible', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/firm/314694');

	const fetchedFirmNode = page.locator('.fg-node').filter({ hasText: '103 Advisory Group' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 20_000,
			message: 'expected the direct-route firm graph to render before asserting graph-derived firm auto-selection',
		})
		.toBe(2);
	await expect(fetchedFirmNode).toHaveCount(1);
	await expect(fetchedFirmNode).toHaveClass(/selected/);
	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct-route firm sidebar to stay focused on 314694 while asserting auto-selection',
			},
		)
		.toBe('firm:314694');
	await expect(page.locator('.fg-link')).toHaveCount(1);
});

test('Fetched nodes without full current relationship data do not auto-select as leaves', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:999112',
				label: 'Partial Fetch',
				group: 'individual',
				crd: '999112',
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const partialLeafNode = page.locator('.fg-node').filter({ hasText: 'Partial Fetch' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the under-hydrated fetched node to render before asserting no auto-selection',
		})
		.toBe(1);
	await expect(partialLeafNode).toHaveCount(1);
	await expect(partialLeafNode).not.toHaveClass(/selected/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
});

test('A direct node route restores that node selection on a clean session', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/individual/3102054');

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 10_000,
			message: 'expected the direct node route to remain active after load',
		})
		.toBe('/individual/3102054');

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:3102054');
});

test('Firm 298880 suppresses FINRA sidebar links', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:298880',
				label: 'Suppressed FINRA Firm',
				group: 'firm',
				firmId: '298880',
				iaSecNumber: '8-114155',
				bcScope: 'Active',
				firmStatus: 'Active',
				activeStates: ['CA'],
				directOwners: [],
				_detailLoaded: true,
				_detailValidated: true,
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const firmNode = page.locator('.fg-node').filter({ hasText: 'Suppressed FINRA Firm' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the suppressed firm node to render before opening the sidebar',
		})
		.toBe(1);
	await firmNode.click({ force: true });

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect(page.locator('#fg-sidebar .fg-ext-link.bc')).toHaveCount(0);
	await expect(page.locator('#fg-sidebar .fg-ext-link.sec', { hasText: 'SEC AdvisorInfo Summary' })).toHaveCount(1);
});

test('Firm 314694 suppresses FINRA sidebar links', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:314694',
				label: '103 Advisory Group',
				group: 'firm',
				firmId: '314694',
				iaSecNumber: '8-123666',
				bcScope: 'Active',
				firmStatus: 'Active',
				activeStates: ['CA'],
				directOwners: [],
				otherNames: ['103 ADVISORY GROUP', '103 ADVISORY GROUP LLC'],
				_detailLoaded: true,
				_detailValidated: true,
			},
		],
		extraLinks: [],
	});
	await page.reload();

	const firmNode = page.locator('.fg-node').filter({ hasText: '103 Advisory Group' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the suppressed 314694 firm node to render before opening the sidebar',
		})
		.toBe(1);
	await firmNode.click({ force: true });

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect(page.locator('#fg-sidebar .fg-ext-link.bc')).toHaveCount(0);
	await expect(page.locator('#fg-sidebar .fg-ext-link.sec', { hasText: 'SEC AdvisorInfo Summary' })).toHaveCount(1);
});

test('Firm 167790 suppresses FINRA sidebar links after direct-route hydration', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/firm/167790');

	const firmNode = page.locator('.fg-node').filter({ hasText: 'CLIENT 1ST ADVISORY GROUP' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 20_000,
			message: 'expected firm 167790 to hydrate on direct route before validating source links',
		})
		.toBe(2);
	await expect(firmNode).toHaveCount(1);
	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct-route sidebar to stay focused on firm 167790',
			},
		)
		.toBe('firm:167790');
	await expect(page.locator('#fg-sidebar .fg-ext-link.bc')).toHaveCount(0);
	await expect(page.locator('#fg-sidebar .fg-ext-link.sec', { hasText: 'SEC AdvisorInfo Summary' })).toHaveCount(1);
});

test('Firm sidebars show graph-derived current connections even without rich firm detail', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.route('**/api/finra/firm/2632784**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ found: false }),
		});
	});

	await page.route('**/api/finra/merged/firm/2632784**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ found: false }),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'firm:2632784',
				label: 'Sparse Detail Firm',
				group: 'firm',
				firmId: '2632784',
				directOwners: [
					{
						crdNumber: '900001',
						legalName: 'Owner Control Person',
						position: 'CEO',
					},
				],
			},
			{
				id: 'person:900001',
				label: 'Owner Control Person',
				group: 'individual',
				crd: '900001',
			},
			{
				id: 'person:900002',
				label: 'Registered Rep Person',
				group: 'individual',
				crd: '900002',
				currentEmployments: [{ firmId: '2632784', firmName: 'Sparse Detail Firm' }],
				currentIAEmployments: [],
				previousEmployments: [],
				previousIAEmployments: [],
			},
		],
		extraLinks: [
			{
				source: 'person:900001',
				target: 'firm:2632784',
				relationship: 'controls',
				position: 'CEO',
			},
			{
				source: 'person:900002',
				target: 'firm:2632784',
				relationship: 'employed_by',
				isCurrent: true,
				startDate: '1/1/2024',
			},
		],
	});
	await page.reload();

	const firmNode = page.locator('.fg-node').filter({ hasText: 'Sparse Detail Firm' });
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded sparse-detail firm graph to render before opening the sidebar',
		})
		.toBe(3);
	await firmNode.click({ force: true });

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/);
	// Employment roster is dashboard-only; side panel keeps Form BD / control positions.
	await expect(page.locator('#fg-sidebar')).toContainText('Open Dashboard to view & select connections');
	await expect(page.locator('#fg-sidebar')).toContainText('Form BD');
	await expect(page.locator('#fg-sidebar')).toContainText('Owner Control Person');
	await expect(page.locator('#fg-sidebar')).not.toContainText('Registered Rep Person');
	await expect(page.locator('#fg-sidebar a[href="/dashboard/firm/2632784"]')).toBeVisible();
});

test('A legacy encoded node route still restores that node selection', async ({ page }) => {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/node/person%3A3102054');

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the legacy encoded node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:3102054');
});

test('A direct node route keeps a fetched inactive leaf node both selected and visibly inactive', async ({ page }) => {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});

	await page.route('**/api/finra/expand/person%3A999999**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [
					{
						id: 'person:999999',
						label: 'Inactive Route Person',
						group: 'individual',
						crd: '999999',
						hasFinraData: true,
						bcScope: 'InActive',
						registrationCount: {
							approvedFinraRegistrationCount: 0,
							approvedSRORegistrationCount: 0,
							approvedStateRegistrationCount: 0,
							approvedIAStateRegistrationCount: 0,
						},
						currentEmployments: [],
						currentIAEmployments: [],
						previousEmployments: [],
						previousIAEmployments: [],
						registeredStates: [],
						registeredSROs: [],
					},
				],
				links: [],
			}),
		});
	});

	await page.route('**/api/finra/individual/999999**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				basicInformation: {
					individualId: '999999',
					firstName: 'Inactive',
					lastName: 'Route Person',
					bcScope: 'InActive',
				},
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				currentEmployments: [],
				currentIAEmployments: [],
				previousEmployments: [],
				previousIAEmployments: [],
				registeredStates: [],
				registeredSROs: [],
			}),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await page.goto('/individual/999999');

	await openGraphSideMenu(page);
	await expect(page.locator('#fg-sidebar')).not.toHaveClass(/hidden/, { timeout: 20_000 });
	await expect
		.poll(
			async () =>
				page.evaluate(() => document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') || document.getElementById('fg-sidebar')?.dataset?.displayedId || ''),
			{
				timeout: 20_000,
				message: 'expected the direct inactive node route to restore the selected node in the sidebar',
			},
		)
		.toBe('person:999999');

	const inactiveSelectedNode = page.locator('.fg-node').filter({ hasText: 'Inactive Route Person' });
	await expect(inactiveSelectedNode).toHaveCount(1);
	await expect(inactiveSelectedNode).toHaveClass(/selected/);
	await expect(inactiveSelectedNode).toHaveClass(/fg-node--inactive/);
	await expect(page.locator('.fg-link')).toHaveCount(0);
});

test('Partial fetch queries still hit remote search even when a loosely matching node is already loaded', async ({ page }) => {
	const requestSequence: string[] = [];
	let localSearchRequestCount = 0;
	let serverSearchRequestCount = 0;
	await page.route('**/api/finra/graph-search**', async (route) => {
		localSearchRequestCount += 1;
		requestSequence.push('local');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ nodes: [], links: [], matchedIds: [] }),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		serverSearchRequestCount += 1;
		requestSequence.push('external-finra');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		serverSearchRequestCount += 1;
		requestSequence.push('external-sec');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:3102054',
				label: 'Regression Person One',
				group: 'individual',
				crd: '3102054',
			},
			{
				id: 'firm:143571',
				label: 'Regression Firm Two',
				group: 'firm',
				firmId: '143571',
			},
		],
		extraLinks: [
			{
				source: 'person:3102054',
				target: 'firm:143571',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
	});
	await page.reload();

	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded session graph to render before testing fetch behavior',
		})
		.toBeGreaterThan(0);

	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-database-search');
	await fetchInput.fill('Regression');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });

	await expect
		.poll(() => localSearchRequestCount, {
			timeout: 10_000,
			message: 'expected the local graph-search API to be consulted before any page-node shortcut',
		})
		.toBeGreaterThan(0);

	await expect
		.poll(() => serverSearchRequestCount, {
			timeout: 10_000,
			message: 'expected a local miss to continue on to server search before any page-node fallback',
		})
		.toBeGreaterThan(0);

	expect(requestSequence[0]).toBe('local');
	await expect(page.locator('#fg-subset-info')).not.toContainText('Already loaded', { timeout: 5_000 });
});

test('Local API hits short-circuit external search before page-node reuse', async ({ page }) => {
	const requestSequence: string[] = [];
	let localSearchRequestCount = 0;
	let serverSearchRequestCount = 0;
	await page.route('**/api/finra/graph-search**', async (route) => {
		localSearchRequestCount += 1;
		requestSequence.push('local');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [
					{
						id: 'person:3102054',
						label: 'Regression Person One',
						group: 'individual',
						crd: '3102054',
					},
					{
						id: 'firm:143571',
						label: 'Regression Firm Two',
						group: 'firm',
						firmId: '143571',
					},
				],
				links: [
					{
						source: 'person:3102054',
						target: 'firm:143571',
						relationship: 'employed_by',
						isCurrent: true,
					},
				],
				matchedIds: ['person:3102054'],
			}),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		serverSearchRequestCount += 1;
		requestSequence.push('external-finra');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		serverSearchRequestCount += 1;
		requestSequence.push('external-sec');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});

	await page.goto('/');
	await resetBrowserGraphState(page);
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:3102054',
				label: 'Regression Person One',
				group: 'individual',
				crd: '3102054',
			},
		],
	});
	await page.reload();
	await expect
		.poll(async () => page.locator('.fg-node').count(), {
			timeout: 10_000,
			message: 'expected the seeded session graph to render before testing the local-hit shortcut',
		})
		.toBeGreaterThan(0);

	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-database-search');
	await fetchInput.fill('3102054');
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 10_000 });

	await expect
		.poll(() => localSearchRequestCount, {
			timeout: 10_000,
			message: 'expected an exact query to hit the local graph-search API first',
		})
		.toBeGreaterThan(0);

	await expect
		.poll(() => serverSearchRequestCount, {
			timeout: 10_000,
			message: 'expected a local API hit to short-circuit the external search endpoints',
		})
		.toBe(0);

	expect(requestSequence).toEqual(['local']);
	await expect(page.locator('#fg-subset-info')).toContainText('Loaded from local API', { timeout: 5_000 });
});

test('Pressing Enter on a unique fetch result opens the node and expands additional hops', async ({ page }) => {
	let expandRequestCount = 0;
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: {
					subset: true,
					profile: 'custom',
					renderedNodes: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			}),
		});
	});
	await page.route('**/api/finra/search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: {
					hits: [
						{
							_source: {
								ind_source_id: '777777',
								ind_firstname: 'Enter',
								ind_lastname: 'Expand',
								ind_current_employments: [],
							},
						},
					],
				},
			}),
		});
	});
	await page.route('**/api/finra/sec-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { hits: [] } }),
		});
	});
	await page.route('**/api/finra/expand/person%3A777777**', async (route) => {
		expandRequestCount += 1;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [
					{
						id: 'person:777777',
						label: 'Enter Expand',
						group: 'individual',
						crd: '777777',
					},
					{
						id: 'firm:777778',
						label: 'Expand Advisors',
						group: 'firm',
						firmId: '777778',
					},
				],
				links: [
					{
						source: 'person:777777',
						target: 'firm:777778',
						relationship: 'employed_by',
						isCurrent: true,
					},
				],
			}),
		});
	});

	await page.goto('/');
	const fetchInput = page.locator('#fg-fetch-input');
	await expect(page.locator('#fg-empty')).not.toHaveClass(/hidden/);
	await fetchInput.fill('Enter Expand');
	await fetchInput.press('Enter');

	await expect
		.poll(() => expandRequestCount, {
			timeout: 10_000,
			message: 'expected Enter to open the matching node and expand its additional hops',
		})
		.toBeGreaterThan(0);
	await expect(page.locator('.fg-node').filter({ hasText: 'Expand Advisors' })).toHaveCount(1);
	await expect(page.locator('.fg-link')).toHaveCount(1);
});
