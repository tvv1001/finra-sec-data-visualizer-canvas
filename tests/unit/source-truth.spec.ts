import { describe, expect, it } from 'vitest';

import { buildIndividualSearchHitStub, hasIndividualSourceCoverage, resolveIndividualSourceDetail } from '../../src/lib/sourceTruth';

describe('resolveIndividualSourceDetail', () => {
	it('treats search-hit-only payloads as scope-only stubs', () => {
		const source = {
			ind_source_id: '6616611',
			ind_firstname: 'Carmine',
			ind_middlename: 'John',
			ind_lastname: 'Camerato II',
			ind_bc_scope: 'NotInScope',
			ind_ia_scope: 'Active',
			ind_bc_disclosure_fl: 'N',
			ind_approved_finra_registration_count: 0,
			ind_current_employments: [
				{
					firm_id: '111838',
					firm_name: 'TOLLESON PRIVATE WEALTH MANAGEMENT',
				},
			],
		};

		const resolved = resolveIndividualSourceDetail(source);

		expect(resolved.searchHitOnly).toBe(true);
		expect(resolved.hasEmbeddedDetail).toBe(false);
		expect(resolved.hasFinraData).toBe(false);
		expect(resolved.hasSecData).toBe(true);
		expect(resolved.detail?.currentEmployments).toEqual([
			{
				firm_id: '111838',
				firm_name: 'TOLLESON PRIVATE WEALTH MANAGEMENT',
			},
		]);
		expect(resolved.detail?.currentIAEmployments).toEqual([]);
	});

	it('keeps embedded detail rich when content is present', () => {
		const source = {
			ind_source_id: '1234567',
			content: JSON.stringify({
				basicInformation: {
					individualId: '1234567',
					firstName: 'Alice',
					lastName: 'Broker',
					bcScope: 'Active',
				},
				currentEmployments: [{ firmId: 1, firmName: 'Firm One' }],
			}),
		};

		const resolved = resolveIndividualSourceDetail(source);

		expect(resolved.searchHitOnly).toBe(false);
		expect(resolved.hasEmbeddedDetail).toBe(true);
		expect(resolved.hasFinraData).toBe(true);
		expect(resolved.detail?.currentEmployments).toHaveLength(1);
	});

	it('returns already normalized detail objects as-is', () => {
		const normalizedDetail = {
			hasFinraData: true,
			hasSecData: false,
			basicInformation: {
				individualId: '5142052',
				firstName: 'Jay',
				lastName: 'Nova',
			},
			currentEmployments: [{ firmId: 123, firmName: 'Firm ABC' }],
		};

		const resolved = resolveIndividualSourceDetail(normalizedDetail);

		expect(resolved.searchHitOnly).toBe(false);
		expect(resolved.hasEmbeddedDetail).toBe(true);
		expect(resolved.detail).toBe(normalizedDetail);
		expect(resolved.detail?.basicInformation?.individualId).toBe('5142052');
	});
});

describe('buildIndividualSearchHitStub', () => {
	it('builds a minimal identity-only stub from search metadata', () => {
		const stub = buildIndividualSearchHitStub({
			ind_source_id: '42',
			ind_firstname: 'Jane',
			ind_lastname: 'Doe',
			ind_bc_scope: 'Active',
			ind_ia_scope: 'NotInScope',
		});

		expect(stub).toMatchObject({
			individualId: '42',
			bcScope: 'Active',
			iaScope: 'NotInScope',
			_searchHitOnly: true,
			basicInformation: {
				individualId: '42',
				firstName: 'Jane',
				lastName: 'Doe',
			},
		});
		expect(stub?.currentEmployments).toEqual([]);
	});
});

describe('hasIndividualSourceCoverage', () => {
	it('rejects explicit NotInScope coverage for FINRA and accepts active SEC coverage', () => {
		const detail = {
			bcScope: 'NotInScope',
			iaScope: 'Active',
			registrationCount: {
				approvedFinraRegistrationCount: 0,
				approvedIAStateRegistrationCount: 0,
			},
		};

		expect(hasIndividualSourceCoverage(detail, 'finra')).toBe(false);
		expect(hasIndividualSourceCoverage(detail, 'sec')).toBe(true);
	});
});
