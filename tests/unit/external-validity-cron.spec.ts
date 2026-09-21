import { describe, expect, it } from 'vitest';

import { buildNameQueryCandidates, extractCandidateIdsFromSearchPayload, shouldSkipCronRun } from '@/lib/externalValidityCron';

describe('externalValidityCron candidate discovery', () => {
	it('generates 3-10 character name terms from seed bank names', () => {
		const candidates = buildNameQueryCandidates({
			individualIds: ['12345'],
			firmIds: ['67890'],
			nameByNumber: {
				individual: { '12345': 'Alicia Torres' },
				firm: { '67890': 'Northwind Capital' },
			},
		});

		expect(candidates.some((term) => term === 'alic')).toBe(true);
		expect(candidates.some((term) => term === 'torre')).toBe(true);
		expect(candidates.some((term) => term === 'north')).toBe(true);
		expect(candidates.every((term) => term.length >= 3 && term.length <= 10)).toBe(true);
	});

	it('pulls numeric CRD/Firm IDs out of search payload hits', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							ind_source_id: '12345',
							content: { basicInformation: { crd: '12345' } },
						},
					},
					{
						_source: {
							firm_id: '67890',
							content: { basicInformation: { firmId: '67890' } },
						},
					},
				],
			},
		};

		expect(extractCandidateIdsFromSearchPayload(payload, 'individual')).toEqual(['12345']);
		expect(extractCandidateIdsFromSearchPayload(payload, 'firm')).toEqual(['67890']);
	});

	it('skips cron runs that are still inside the cooldown window', () => {
		const lastRunAt = new Date('2026-07-26T00:00:00.000Z').toISOString();
		expect(shouldSkipCronRun(lastRunAt, Date.parse('2026-07-26T03:00:00.000Z'), 360)).toBe(true);
		expect(shouldSkipCronRun(lastRunAt, Date.parse('2026-07-26T08:00:00.000Z'), 360)).toBe(false);
	});
});
