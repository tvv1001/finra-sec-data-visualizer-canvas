import { describe, expect, it } from 'vitest';

import {
	buildPrimedBundleInventoryTotals,
	classifyFetchedPayloadOutcome,
	extractCardSummaryFields,
	fetchedPayloadHasSourceCoverage,
	summarizeFetchResults,
} from '../../src/app/api/dashboard/refresh/route';
import {
	buildQueueCardsFromFetchResults,
	computeQueryFetchCounts,
	computeQuerySaveStats,
	describeDashboardRequestFailure,
	describeQuerySaveChange,
	extractConnectionCards,
	extractNoticeFilingsCards,
	extractRegistrationCards,
	parseDashboardSelectionFromUrl,
	shouldShowQueueCardError,
	shouldShowQueueCardSkipped,
} from '../../src/app/dashboard/page';
import { buildDashboardProfileLinks } from '../../src/lib/finra-graph/linkSuppression';

const TEST_FINRA_ONLY_CRD = '9100001';
const TEST_DUAL_SOURCE_CRD = '9100002';
const TEST_FIRM_ID = '88001';
const TEST_PREVIOUS_FIRM_ID = '88002';

describe('parseDashboardSelectionFromUrl', () => {
	it('reads an individual SEC selection from dashboard query params', () => {
		expect(parseDashboardSelectionFromUrl('https://example.com/dashboard?source=sec&CRD_individual=6655996&sec=1')).toEqual({
			entity: 'individual',
			id: '6655996',
			source: 'sec',
			availableSources: ['sec'],
		});
	});

	it('preserves both source flags for a shared dashboard link', () => {
		expect(parseDashboardSelectionFromUrl('https://example.com/dashboard?source=sec&CRD_individual=6655996&sec=1&finra=1')).toEqual({
			entity: 'individual',
			id: '6655996',
			source: 'sec',
			availableSources: ['finra', 'sec'],
		});
	});
});

describe('buildPrimedBundleInventoryTotals', () => {
	it('does not double-count the same people or firms across FINRA and SEC primed bundles', () => {
		const totals = buildPrimedBundleInventoryTotals([
			{ bundleName: 'finra-individual', recordCount: 10 },
			{ bundleName: 'sec-individual', recordCount: 8 },
			{ bundleName: 'finra-firm', recordCount: 6 },
			{ bundleName: 'sec-firm', recordCount: 4 },
		]);

		expect(totals.people).toBe(10);
		expect(totals.firms).toBe(6);
		expect(totals.unique).toBe(16);
	});
});

describe('buildDashboardProfileLinks', () => {
	it('omits SEC profile links for IDs known to be suppressed for SEC detail pages', () => {
		const links = buildDashboardProfileLinks('individual', '18040', {
			basicInformation: { individualId: '18040' },
		});

		expect(links.map((link) => link.label)).not.toContain('SEC profile ↗');
	});

	it('keeps FINRA and SEC profile links when the payload shows source coverage', () => {
		const links = buildDashboardProfileLinks('individual', '123456', {
			hasFinraData: true,
			hasSecData: true,
			basicInformation: { individualId: '123456' },
		});

		expect(links.map((link) => link.label)).toEqual(expect.arrayContaining(['FINRA profile ↗', 'SEC profile ↗']));
	});
});

describe('extractRegistrationCards', () => {
	it('collects registration cards from stringified nested payload objects', () => {
		const cards = extractRegistrationCards({
			content: JSON.stringify({
				registrations: [{ registrationName: 'Series 6', status: 'Active', effectiveDate: '2024-01-01' }],
			}),
		});

		expect(cards).toEqual([
			{
				title: 'Series 6',
				meta: 'Active',
				subtitle: '2024-01-01',
			},
		]);
	});
});

describe('extractConnectionCards', () => {
	it('collects connection cards from current and previous connection payloads', () => {
		const cards = extractConnectionCards(
			{
				currentConnections: [{ firmName: 'Example Advisory', relationship: 'Owner' }],
			},
			'currentConnections',
		);

		expect(cards).toEqual([
			{
				title: 'Example Advisory', haystack: 'example advisory owner active', statusTag: 'Active',
				meta: 'Owner',
				subtitle: '',
			},
		]);
	});

	it('keeps the relationship, dates, and address together for clearer connection cards', () => {
		const cards = extractConnectionCards(
			{
				previousConnections: [
					{
						firmName: 'Northstar Advisory',
						relationship: 'Former owner',
						effectiveDate: '2020-01-01',
						address: '123 Market St, Denver, CO',
					},
				],
			},
			'previousConnections',
		);

		expect(cards).toEqual([
			{
				title: 'Northstar Advisory', haystack: 'northstar advisory 2020-01-01 former owner active', statusTag: 'Active',
				meta: 'Former owner',
				subtitle: '2020-01-01 • 123 Market St, Denver, CO',
				startDate: '2020-01-01',
				address: '123 Market St, Denver, CO',
			},
		]);
	});

	it('extracts connection cards from wrapped payload objects', () => {
		const cards = extractConnectionCards(
			{
				content: JSON.stringify({
					currentConnections: [{ connectionName: 'Horizon Partners', relationship: 'Principal', effectiveDate: '2024-06-01' }],
				}),
			},
			'currentConnections',
		);

		expect(cards).toEqual([
			{
				title: 'Horizon Partners', haystack: 'horizon partners 2024-06-01 principal active', statusTag: 'Active',
				meta: 'Principal',
				subtitle: '2024-06-01',
				startDate: '2024-06-01',
			},
		]);
	});
});

describe('extractNoticeFilingsCards', () => {
	it('collects notice-filing cards from nested payload objects', () => {
		const cards = extractNoticeFilingsCards({
			basicInformation: {},
			noticeFilings: [
				{
					jurisdiction: 'Colorado',
					status: 'Active',
					effectiveDate: '2024-01-01',
					description: 'Filed for notice status',
				},
			],
		});

		expect(cards).toEqual([
			{
				title: 'Colorado',
				meta: 'Active',
				subtitle: '2024-01-01',
				detail: 'Filed for notice status',
			},
		]);
	});

	it('reads notice-filing cards from a stringified nested payload', () => {
		const cards = extractNoticeFilingsCards({
			content: JSON.stringify({
				noticeFilingsDetails: [
					{
						jurisdiction: 'Texas',
						status: 'Pending',
						effectiveDate: '2024-07-01',
						description: 'Filed through a wrapped payload',
					},
				],
			}),
		});

		expect(cards).toEqual([
			{
				title: 'Texas',
				meta: 'Pending',
				subtitle: '2024-07-01',
				detail: 'Filed through a wrapped payload',
			},
		]);
	});
	it('counts newly saved records and source saves per query', () => {
		const resolution = [
			{ query: '100', crds: ['100', '101'] },
			{ query: '200', crds: ['200'] },
		];
		const fetchedItems = [
			{ crd: '100', type: 'individual', status: 'ok', cardKey: 'individual:100', newSourceSaved: true, newRecordSaved: true },
			{ crd: '100', type: 'individual', status: 'ok', cardKey: 'individual:100', newSourceSaved: true, newRecordSaved: false },
			{ crd: '101', type: 'firm', status: 'error', cardKey: 'firm:101', newSourceSaved: false, newRecordSaved: false },
			{ crd: '200', type: 'individual', status: 'ok', cardKey: 'individual:200', newSourceSaved: false, newRecordSaved: false },
		];

		expect(computeQuerySaveStats(resolution, fetchedItems)).toEqual({
			'100': {
				fetchedCount: 2,
				skippedCount: 0,
				savedSourceCount: 2,
				savedRecordCount: 1,
				updatedExistingSourceCount: 1,
				updatedExistingRecordCount: 1,
				errorCount: 1,
			},
			'200': {
				fetchedCount: 1,
				skippedCount: 0,
				savedSourceCount: 0,
				savedRecordCount: 0,
				updatedExistingSourceCount: 0,
				updatedExistingRecordCount: 0,
				errorCount: 0,
			},
		});
	});
});

describe('describeQuerySaveChange', () => {
	it('describes mixed new and existing-record source growth', () => {
		expect(
			describeQuerySaveChange({
				savedRecordCount: 11,
				updatedExistingRecordCount: 1,
				updatedExistingSourceCount: 1,
			}),
		).toBe('11 new CRDs • 1 existing CRD gained 1 new source');
	});

	it('describes pure existing-record source expansion', () => {
		expect(
			describeQuerySaveChange({
				savedRecordCount: 0,
				updatedExistingRecordCount: 2,
				updatedExistingSourceCount: 3,
			}),
		).toBe('2 existing CRDs gained 3 new sources');
	});

	it('describes no newly saved data', () => {
		expect(describeQuerySaveChange({ savedRecordCount: 0, updatedExistingRecordCount: 0, updatedExistingSourceCount: 0 })).toBe('no new data saved');
	});
});

describe('summarizeFetchResults', () => {
	it('reports actual new source and unique record counts separately', () => {
		const summary = summarizeFetchResults([
			{
				crd: '100',
				source: 'finra',
				type: 'individual',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'ok',
				redisWrite: 'written',
				cardKey: 'individual:100',
				newSourceSaved: true,
				newRecordSaved: true,
			},
			{
				crd: '100',
				source: 'sec',
				type: 'individual',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'ok',
				redisWrite: 'written',
				cardKey: 'individual:100',
				newSourceSaved: true,
				newRecordSaved: false,
			},
			{
				crd: '100',
				source: 'sec',
				type: 'firm',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'skipped',
				redisWrite: 'skipped:out-of-scope-source-payload',
				skipReason: 'out-of-scope-source-payload',
			},
			{
				crd: '200',
				source: 'finra',
				type: 'firm',
				url: '',
				cacheFile: '',
				redisKey: '',
				status: 'error',
				redisWrite: 'error',
				cardKey: 'firm:200',
				newSourceSaved: false,
				newRecordSaved: false,
			},
		]);

		expect(summary).toEqual({
			crdCount: 2,
			requests: 4,
			successCount: 2,
			skippedCount: 1,
			errorCount: 1,
			newSourceCount: 2,
			newRecordCount: 1,
			newPeopleCount: 1,
			newFirmCount: 0,
		});
	});
});

describe('fetchedPayloadHasSourceCoverage', () => {
	it('rejects a SEC individual payload that is explicitly not in SEC scope', () => {
		const secPayload = {
			hits: {
				hits: [
					{
						_source: {
							iacontent: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_FINRA_ONLY_CRD),
									bcScope: 'Active',
									iaScope: 'NotInScope',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 0,
								},
								currentEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								currentIAEmployments: [],
								previousEmployments: [{ firmId: Number(TEST_PREVIOUS_FIRM_ID) }],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};
		const finraPayload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_FINRA_ONLY_CRD),
									bcScope: 'Active',
									iaScope: 'NotInScope',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 0,
								},
								currentEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								currentIAEmployments: [],
								previousEmployments: [{ firmId: Number(TEST_PREVIOUS_FIRM_ID) }],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		expect(fetchedPayloadHasSourceCoverage(secPayload, { source: 'sec', type: 'individual', crd: TEST_FINRA_ONLY_CRD })).toBe(false);
		expect(fetchedPayloadHasSourceCoverage(finraPayload, { source: 'finra', type: 'individual', crd: TEST_FINRA_ONLY_CRD })).toBe(true);
		expect(classifyFetchedPayloadOutcome(secPayload, { source: 'sec', type: 'individual', crd: TEST_FINRA_ONLY_CRD })).toEqual({
			status: 'skipped',
			skipReason: 'out-of-scope-source-payload',
		});
	});

	it('accepts a truly dual-source individual payload', () => {
		const secPayload = {
			hits: {
				hits: [
					{
						_source: {
							iacontent: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_DUAL_SOURCE_CRD),
									bcScope: 'Active',
									iaScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 1,
								},
								currentEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								currentIAEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								previousEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};
		const finraPayload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_DUAL_SOURCE_CRD),
									bcScope: 'Active',
									iaScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 1,
								},
								currentEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								currentIAEmployments: [{ firmId: Number(TEST_FIRM_ID) }],
								previousEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		expect(fetchedPayloadHasSourceCoverage(secPayload, { source: 'sec', type: 'individual', crd: TEST_DUAL_SOURCE_CRD })).toBe(true);
		expect(fetchedPayloadHasSourceCoverage(finraPayload, { source: 'finra', type: 'individual', crd: TEST_DUAL_SOURCE_CRD })).toBe(true);
	});
});

describe('extractCardSummaryFields', () => {
	it('prefers concise, explicit metadata over deep nested JSON-like values', () => {
		const summary = extractCardSummaryFields(
			{
				basicInformation: {
					name: 'Generic Record',
					bcScope: 'active',
					iaScope: 'inactive',
				},
				memberSince: '2020-01-01',
				registrationDate: '2024-09-15',
				details: {
					startDate: '1999-01-01',
					raw: '{"memberSince":"2024-06-01"}',
				},
			},
			'12345',
		);

		expect(summary.name).toBe('Generic Record');
		expect(summary.memberSince).toBe('2020-01-01');
		expect(summary.statusText).toContain('FINRA Active');
		expect(summary.statusText).toContain('SEC Inactive');
	});

	it('keeps status text scoped to the selected source when a source hint is provided', () => {
		const summary = extractCardSummaryFields(
			{
				basicInformation: {
					name: 'Generic Record',
					bcScope: 'active',
					iaScope: 'inactive',
				},
			},
			'12345',
			'finra',
		);

		expect(summary.statusText).toBe('FINRA Active');
		expect(summary.statusText).not.toContain('SEC');
	});

	it('uses common full-name and legal-name fields when building the card summary name', () => {
		const individualSummary = extractCardSummaryFields(
			{
				basicInformation: {
					fullName: 'Jane Doe',
				},
			},
			'12345',
		);
		const firmSummary = extractCardSummaryFields(
			{
				basicInformation: {
					legalName: 'Northwind Advisors',
				},
			},
			'54321',
		);

		expect(individualSummary.name).toBe('Jane Doe');
		expect(firmSummary.name).toBe('Northwind Advisors');
	});
});

describe('buildQueueCardsFromFetchResults', () => {
	it('preserves skipped and error state per source', () => {
		const cards = buildQueueCardsFromFetchResults([
			{ crd: '7506710', source: 'finra', type: 'individual', status: 'ok' },
			{ crd: '7506710', source: 'sec', type: 'individual', status: 'skipped', skipReason: 'out-of-scope-source-payload' },
			{ crd: '7506710', source: 'finra', type: 'firm', status: 'error', error: 'HTTP 500' },
		]);

		expect(cards).toEqual([
			{
				id: '7506710',
				entity: 'individual',
				files: 2,
				sources: [
					{ source: 'finra', status: 'ok', error: undefined, skipReason: undefined },
					{ source: 'sec', status: 'skipped', error: undefined, skipReason: 'out-of-scope-source-payload' },
				],
			},
			{
				id: '7506710',
				entity: 'firm',
				files: 1,
				sources: [{ source: 'finra', status: 'error', error: 'HTTP 500', skipReason: undefined }],
			},
		]);
	});
});

describe('queue card banners', () => {
	it('shows the red error banner only for true failures', () => {
		expect(
			shouldShowQueueCardError({
				sources: [
					{ source: 'finra', status: 'ok' },
					{ source: 'sec', status: 'skipped' },
				],
			}),
		).toBe(false);
		expect(
			shouldShowQueueCardSkipped({
				sources: [
					{ source: 'finra', status: 'ok' },
					{ source: 'sec', status: 'skipped' },
				],
			}),
		).toBe(true);
		expect(
			shouldShowQueueCardError({
				sources: [
					{ source: 'finra', status: 'ok' },
					{ source: 'sec', status: 'error' },
				],
			}),
		).toBe(true);
	});
});

describe('describeDashboardRequestFailure', () => {
	it('surfaces a clearer timeout message for likely Vercel duration failures', () => {
		expect(
			describeDashboardRequestFailure({
				status: 504,
				bodyText: 'Gateway Timeout',
				elapsedSec: 30,
			}),
		).toContain('Queue likely timed out after 30s');
	});

	it('explains non-JSON gateway failures', () => {
		expect(
			describeDashboardRequestFailure({
				status: 500,
				contentType: 'text/html',
				bodyText: '<html>server exploded</html>',
			}),
		).toContain('received JSON');
	});
});
