import { expect, test } from '@playwright/test';
import {
	diffConnectionCounts,
	extractEmployerFirmsFromIndividualPayload,
	readConnectionSnapshot,
	validateIndividualEmployerBidirectionalRefs,
	writeConnectionSnapshot,
} from './helpers/firm-connection-validation';

const INDIVIDUAL_CRD = String(process.env.FIRM_CONN_TEST_CRD || '1085996').trim();

test.describe('individual ↔ firm connection validation', () => {
	test.describe.configure({ timeout: 120_000 });

	test('person detail page lists employers; each firm roster includes that person CRD', async ({ page, request }) => {
		// Load the person page first (page-load upsert path when writes are enabled).
		await page.goto(`/dashboard/individual/${INDIVIDUAL_CRD}`);
		await expect(page.locator('body')).toContainText(new RegExp(INDIVIDUAL_CRD));
		await expect(page.getByText(/Previous Employment|Current Employment/i).first()).toBeVisible({
			timeout: 30_000,
		});

		const result = await validateIndividualEmployerBidirectionalRefs(request, INDIVIDUAL_CRD, {
			updateSnapshot: process.env.UPDATE_FIRM_CONNECTION_SNAPSHOT === '1',
		});

		expect(result.employers.length, 'expected at least one employer firm CRD on the person record').toBeGreaterThan(0);

		// Person detail should render an employment section (row count may exceed unique firm CRDs).
		const employmentHeading = page.getByRole('heading', { name: /^(Current|Previous) Employment \(\d+\)$/ }).first();
		await expect(employmentHeading).toBeVisible();

		expect(
			result.missingOnFirm,
			`person ${INDIVIDUAL_CRD} missing from firm-connections for: ${result.missingOnFirm
				.map((m) => `${m.firmId} (${m.firmName || 'unnamed'})`)
				.join(', ')}`,
		).toEqual([]);

		const snapshot = readConnectionSnapshot(INDIVIDUAL_CRD);
		if (!snapshot) {
			// First run without a fixture: write baseline so later runs detect drift.
			writeConnectionSnapshot({
				individualCrd: INDIVIDUAL_CRD,
				updatedAt: new Date().toISOString(),
				firms: result.counts,
			});
			test.info().annotations.push({
				type: 'note',
				description: `Created baseline firm-connection count snapshot for ${INDIVIDUAL_CRD}`,
			});
			return;
		}

		const changes = diffConnectionCounts(snapshot, result.counts);
		if (changes.length) {
			const summary = changes
				.map((change) => {
					const beforeTotal = change.before?.total ?? 'missing';
					return `${change.firmId}: ${beforeTotal} → ${change.after.total} (cur ${change.after.currentCount}, prev ${change.after.previousCount})`;
				})
				.join('; ');
			test.info().annotations.push({
				type: 'firm-connection-count-change',
				description: summary,
			});
			console.warn(`[firm-connections] count drift for ${INDIVIDUAL_CRD}: ${summary}`);
			// Live Redis rosters can grow between runs; reverse-ref integrity is the hard gate.
			// Set FIRM_CONN_STRICT_COUNTS=1 to fail smoke on count drift, or
			// UPDATE_FIRM_CONNECTION_SNAPSHOT=1 to re-baseline.
			if (process.env.FIRM_CONN_STRICT_COUNTS === '1') {
				expect(
					changes,
					`Firm connection counts changed for ${INDIVIDUAL_CRD}. Re-baseline with UPDATE_FIRM_CONNECTION_SNAPSHOT=1 if intentional.\n${summary}`,
				).toEqual([]);
			}
		}
	});

	test('individual API employer extraction is stable for the smoke CRD', async ({ request }) => {
		const response = await request.get(`/api/finra/individual/${INDIVIDUAL_CRD}`);
		expect(response.ok()).toBeTruthy();
		const payload = await response.json();
		const employers = extractEmployerFirmsFromIndividualPayload(payload);
		expect(employers.every((row) => /^\d{1,10}$/.test(row.firmId))).toBe(true);
		expect(employers.length).toBeGreaterThan(0);
	});
});
