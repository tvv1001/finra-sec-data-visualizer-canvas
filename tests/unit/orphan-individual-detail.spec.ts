import { describe, expect, it } from 'vitest';
import { applyIndividualDetail } from '@/lib/finra-graph/detailUtils';
import { buildParentFirmSummaryLinks } from '@/lib/finra-graph/externalLinks';

describe('non-live / orphan individual detail', () => {
	it('synthesizes a parent-firm employment card for non-live CRDs', () => {
		const node: any = { id: 'person:1090661', group: 'individual', label: 'Person 1090661' };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '1090661',
					name: 'RUETHER, JULIE ANN',
					position: 'CHIEF COMPLIANCE OFFICER',
					firmName: 'IDS LIFE INSURANCE COMPANY',
					parentCrd: '6321',
					parentType: 'firm',
				},
			},
			'1090661',
		);

		expect(node.stub).toBe(true);
		expect(node.orphanParentCrd).toBe('6321');
		expect(node.orphanPosition).toMatch(/CHIEF COMPLIANCE OFFICER/i);
		expect(node.currentEmployments).toEqual([
			expect.objectContaining({
				firmId: '6321',
				firmName: 'IDS LIFE INSURANCE COMPANY',
				position: 'CHIEF COMPLIANCE OFFICER',
				_orphanAffiliation: true,
			}),
		]);
		expect(String(node.label)).toMatch(/Julie|RUETHER/i);
	});

	it('keeps parent-firm employment card fields for Schwarzmann-style CEO/COB orphans', () => {
		const node: any = { id: 'person:4742555', group: 'individual', label: 'Person 4742555', stub: true, bcScope: 'NotInScope' };
		applyIndividualDetail(
			node,
			{
				found: true,
				orphan: {
					crd: '4742555',
					name: 'SCHWARZMANN, MARK EDWARD',
					position: 'DIRECTOR, CEO, COB',
					firmName: 'IDS LIFE INSURANCE COMPANY',
					parentCrd: '6321',
					parentType: 'firm',
				},
			},
			'4742555',
		);

		expect(node.currentEmployments).toEqual([
			expect.objectContaining({
				firmId: '6321',
				firmName: 'IDS LIFE INSURANCE COMPANY',
				position: 'DIRECTOR, CEO, COB',
				_orphanAffiliation: true,
			}),
		]);
		expect(node.hasFinraData).toBe(false);
		expect(node.orphanParentCrd).toBe('6321');
	});

	it('uses the SEC registration number for SEC summary links instead of the CRD', () => {
		const links = buildParentFirmSummaryLinks({
			bcScope: 'Active',
			currentEmployments: [{ firmId: '37404' }],
			iaSecNumber: '8-47739',
			basicInformation: { iaSECNumber: '8-47739' },
		});

		expect(links.find((link) => link.className === 'sec')?.href).toBe('https://adviserinfo.sec.gov/firm/summary/8-47739');
	});
});
