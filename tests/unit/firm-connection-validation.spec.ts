import { describe, expect, it } from 'vitest';
import {
	diffConnectionCounts,
	extractEmployerFirmsFromIndividualPayload,
	rosterIncludesIndividual,
} from '../e2e/helpers/firm-connection-validation';

describe('firm-connection-validation helpers', () => {
	it('extracts unique employer firm CRDs from individual detail payload', () => {
		const employers = extractEmployerFirmsFromIndividualPayload({
			bccontent: {
				currentEmployments: [{ firmId: 100, firmName: 'Now' }],
				previousEmployments: [
					{ firmId: '100', firmName: 'Now Prev' },
					{ firmId: 200, firmName: 'Then' },
				],
				previousIAEmployments: [{ firmId: 200, firmName: 'Then IA' }],
			},
		});
		expect(employers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ firmId: '100', isCurrent: true }),
				expect.objectContaining({ firmId: '200', isCurrent: false }),
			]),
		);
		expect(employers).toHaveLength(2);
	});

	it('detects whether a firm roster includes an individual CRD', () => {
		expect(
			rosterIncludesIndividual(
				{
					currentConnections: [{ individualId: '1', name: 'A', isCurrent: true }],
					previousConnections: [{ individualId: '1085996', name: 'Tim', isCurrent: false }],
				},
				'1085996',
			),
		).toBe(true);
		expect(rosterIncludesIndividual({ currentConnections: [], previousConnections: [] }, '1085996')).toBe(false);
	});

	it('diffs firm connection counts against a snapshot', () => {
		const changes = diffConnectionCounts(
			{
				individualCrd: '1085996',
				updatedAt: '2026-01-01T00:00:00.000Z',
				firms: {
					'11469': { firmId: '11469', currentCount: 2, previousCount: 2, total: 4 },
				},
			},
			{
				'11469': { firmId: '11469', currentCount: 2, previousCount: 3, total: 5 },
			},
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].before?.total).toBe(4);
		expect(changes[0].after.total).toBe(5);
	});
});
