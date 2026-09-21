import { describe, expect, it } from 'vitest';
import { getRecordDashboardDisplayMeta, mergeDashboardDetailPayload, summarizeRecordDetail } from '../../src/components/RecordDashboard';
import { getRecordDisplayName } from '../../src/lib/recordDisplay';

describe('summarizeRecordDetail', () => {
	it('builds a compact individual summary from the detail payload', () => {
		const summary = summarizeRecordDetail(
			{
				name: 'Alice Johnson',
				basicInformation: { crdNumber: '8276416' },
				currentEmployment: [{ firmName: 'Example Advisory' }],
				employmentHistory: [{ firmName: 'Example Advisory' }],
			},
			'individual',
			'8276416',
		);

		expect(summary.title).toBe('Alice Johnson');
		expect(summary.subtitle).toContain('8276416');
		expect(summary.keyFacts).toContainEqual(expect.objectContaining({ label: 'Current employer', value: 'Example Advisory' }));
	});

	it('exposes dashboard metadata for the read-only shell', () => {
		const meta = getRecordDashboardDisplayMeta(
			{
				name: 'Alice Johnson',
				basicInformation: { crdNumber: '8276416' },
				status: 'Active',
			},
			'individual',
			'8276416',
		);

		expect(meta.badgeLabel).toBe('Read-only');
		expect(meta.overviewCards).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: 'Entity', value: 'Individual' }), expect.objectContaining({ label: 'Record ID', value: '8276416' })]),
		);
	});

	it('marks an individual as inactive when only historical employment evidence exists', () => {
		const meta = getRecordDashboardDisplayMeta(
			{
				previousEmployments: [{ firmName: 'Old Firm LLC' }],
				currentEmployments: [],
				currentIAEmployments: [],
			},
			'individual',
			'1768782',
		);

		expect(meta.overviewCards).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Status', value: 'Inactive' })]));
	});

	it('marks an individual as active when current employment exists', () => {
		const meta = getRecordDashboardDisplayMeta(
			{
				currentEmployments: [{ firmName: 'Current Firm LLC' }],
			},
			'individual',
			'1768782',
		);

		expect(meta.overviewCards).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Status', value: 'Active' })]));
	});

	it('uses the firm legal name instead of the fallback placeholder', () => {
		expect(getRecordDisplayName({ basicInformation: { legalName: 'CardJSON' } }, 'firm', '149777')).toBe('CardJSON');
	});

	it('uses the individual full name instead of the fallback placeholder', () => {
		expect(getRecordDisplayName({ basicInformation: { firstName: 'Alice', lastName: 'Johnson' } }, 'individual', '8276416')).toBe('Alice Johnson');
	});

	it('merges node-route stub data with the full record payload without dropping rich detail', () => {
		const merged = mergeDashboardDetailPayload(
			{
				id: 'firm:5393',
				label: 'Charles Schwab & Co., Inc.',
				group: 'firm',
				firmId: '5393',
			},
			{
				found: true,
				basicInformation: {
					firmName: 'Charles Schwab & Co., Inc.',
					bdSECNumber: '8-1029',
				},
				registrationStatus: [{ status: 'Approved' }],
			},
		) as Record<string, any>;

		expect(merged.label).toBe('Charles Schwab & Co., Inc.');
		expect(merged.basicInformation.firmName).toBe('Charles Schwab & Co., Inc.');
		expect(merged.basicInformation.bdSECNumber).toBe('8-1029');
		expect(merged.registrationStatus).toEqual([{ status: 'Approved' }]);
	});
});
