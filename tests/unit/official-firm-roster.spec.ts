import { describe, expect, it } from 'vitest';
import { mapOfficialSearchHitsToConnections } from '@/lib/officialFirmRoster';

describe('mapOfficialSearchHitsToConnections', () => {
	it('classifies exact CRD employments as current or previous people', () => {
		const entries = mapOfficialSearchHitsToConnections('2525', [
			{
				_source: {
					ind_source_id: '100',
					ind_firstname: 'Ada',
					ind_lastname: 'Lovelace',
					ind_current_employments: [{ firm_id: '2525', firm_name: 'DEUTSCHE BANK SECURITIES INC.', registrationBeginDate: '1/1/2020' }],
				},
				inner_hits: {
					ind_current_employments: {
						hits: { hits: [{ _source: { firm_id: '2525', firm_name: 'DEUTSCHE BANK SECURITIES INC.', registrationBeginDate: '1/1/2020' } }] },
					},
				},
			},
			{
				_source: {
					ind_source_id: '200',
					ind_firstname: 'Grace',
					ind_lastname: 'Hopper',
				},
				inner_hits: {
					ind_previous_employments: {
						hits: { hits: [{ _source: { firm_id: '2525', firm_name: 'DEUTSCHE BANK SECURITIES INC.', registrationEndDate: '2/2/2019' } }] },
					},
				},
			},
		], 'official-search-finra');

		const people = entries.filter((entry) => entry.individualId);
		const current = people.filter((entry) => entry.isCurrent);
		const previous = people.filter((entry) => !entry.isCurrent);
		expect(current).toHaveLength(1);
		expect(current[0]?.individualId).toBe('100');
		expect(previous).toHaveLength(1);
		expect(previous[0]?.individualId).toBe('200');
		expect(entries.some((entry) => entry.firmId === '2525')).toBe(false);
	});


});
