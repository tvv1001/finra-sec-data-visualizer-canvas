import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
	saveGraph: vi.fn(),
}));

vi.mock('@/lib/seedStore', () => ({
	rememberRecentSeed: vi.fn(),
}));

import { getFullGraph, saveGraph } from '@/lib/graphStore';
import { rememberRecentSeed } from '@/lib/seedStore';
import { buildMainAppGraphArtifactsFromFetchedPayload, publishFetchedRecordsToMainApp } from '@/app/api/dashboard/refresh/route';

const TEST_DUAL_SOURCE_CRD = '9000001';
const TEST_FIRM_ID = '88001';
const TEST_PERSON_FIRST_NAME = 'GENERIC';
const TEST_PERSON_LAST_NAME = 'RECORD';
const TEST_FIRM_NAME = 'GENERIC FIRM';

describe('buildMainAppGraphArtifactsFromFetchedPayload', () => {
	it('builds a person node plus employment firm links from a fetched individual payload', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_DUAL_SOURCE_CRD),
									firstName: TEST_PERSON_FIRST_NAME,
									lastName: TEST_PERSON_LAST_NAME,
									bcScope: 'Active',
									iaScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 1,
								},
								currentEmployments: [{ firm_id: TEST_FIRM_ID, firm_name: TEST_FIRM_NAME }],
								currentIAEmployments: [{ firm_id: TEST_FIRM_ID, firm_name: TEST_FIRM_NAME }],
								previousEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		const artifacts = buildMainAppGraphArtifactsFromFetchedPayload(payload, {
			crd: TEST_DUAL_SOURCE_CRD,
			source: 'finra',
			type: 'individual',
		});

		expect(artifacts.nodes.some((node) => node.id === `person:${TEST_DUAL_SOURCE_CRD}` && node.label === `${TEST_PERSON_FIRST_NAME} ${TEST_PERSON_LAST_NAME}`)).toBe(true);
		expect(artifacts.nodes.some((node) => node.id === `firm:${TEST_FIRM_ID}` && node.group === 'firm')).toBe(true);
		expect(artifacts.links.some((link) => link.source === `person:${TEST_DUAL_SOURCE_CRD}` && link.target === `firm:${TEST_FIRM_ID}` && link.relationship === 'employed_by')).toBe(
			true,
		);
	});

	it('builds a firm link from SEC employment identifiers when no firm id is present', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							iacontent: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_DUAL_SOURCE_CRD),
									firstName: TEST_PERSON_FIRST_NAME,
									lastName: TEST_PERSON_LAST_NAME,
								},
								currentEmployments: [{ firm_name: 'Fisher Investments', bdSECNumber: '8-29362' }],
								currentIAEmployments: [{ firm_name: 'Fisher Investments', iaSECNumber: '8-29362' }],
								previousEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		const artifacts = buildMainAppGraphArtifactsFromFetchedPayload(payload, {
			crd: TEST_DUAL_SOURCE_CRD,
			source: 'sec',
			type: 'individual',
		});

		expect(artifacts.nodes.some((node) => node.id === 'firm:8-29362' && node.group === 'firm')).toBe(true);
		expect(artifacts.links.some((link) => link.source === `person:${TEST_DUAL_SOURCE_CRD}` && link.target === 'firm:8-29362' && link.relationship === 'employed_by')).toBe(true);
	});
});

describe('publishFetchedRecordsToMainApp', () => {
	beforeEach(() => {
		vi.mocked(rememberRecentSeed).mockReset();
		vi.mocked(saveGraph).mockReset();
		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: `person:${TEST_DUAL_SOURCE_CRD}`,
					label: 'Old Label',
					group: 'individual',
					crd: TEST_DUAL_SOURCE_CRD,
					basicInformation: {
						individualId: TEST_DUAL_SOURCE_CRD,
						firstName: 'GENERIC',
						lastName: 'CACHE',
					},
				},
			],
			links: [],
			meta: { generated: '2026-01-01T00:00:00.000Z' },
		});
	});

	it('remembers successful fetches and merges them into the graph store', async () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: Number(TEST_DUAL_SOURCE_CRD),
									firstName: TEST_PERSON_FIRST_NAME,
									lastName: TEST_PERSON_LAST_NAME,
									bcScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
								},
								currentEmployments: [{ firm_id: TEST_FIRM_ID, firm_name: TEST_FIRM_NAME }],
								previousEmployments: [],
								currentIAEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		const summary = await publishFetchedRecordsToMainApp([
			{
				crd: TEST_DUAL_SOURCE_CRD,
				source: 'finra',
				type: 'individual',
				status: 'ok',
				payload,
			},
		]);

		expect(rememberRecentSeed).toHaveBeenCalledWith('individual', TEST_DUAL_SOURCE_CRD);
		expect(summary).toMatchObject({ rememberedSeeds: 1, nodesAdded: 1, nodesUpdated: 1, linksAdded: 1 });
		expect(saveGraph).toHaveBeenCalledTimes(1);
		const savedGraph = vi.mocked(saveGraph).mock.calls[0][0] as any;
		expect(savedGraph.nodes.some((node: any) => node.id === `person:${TEST_DUAL_SOURCE_CRD}` && node.label === `${TEST_PERSON_FIRST_NAME} ${TEST_PERSON_LAST_NAME}`)).toBe(true);
		expect(savedGraph.nodes.some((node: any) => node.id === `firm:${TEST_FIRM_ID}`)).toBe(true);
		expect(savedGraph.links.some((link: any) => link.source === `person:${TEST_DUAL_SOURCE_CRD}` && link.target === `firm:${TEST_FIRM_ID}`)).toBe(true);
	});

	it('ignores errored records for main-app publishing', async () => {
		const summary = await publishFetchedRecordsToMainApp([
			{
				crd: '1234567',
				source: 'sec',
				type: 'individual',
				status: 'error',
				payload: null,
			},
		]);

		expect(summary).toEqual({ rememberedSeeds: 0, nodesAdded: 0, nodesUpdated: 0, linksAdded: 0 });
		expect(rememberRecentSeed).not.toHaveBeenCalled();
		expect(saveGraph).not.toHaveBeenCalled();
	});
});
