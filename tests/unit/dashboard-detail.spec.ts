import { describe, expect, it } from 'vitest';
import {
	extractPayloadFromDetail,
	mergeEmploymentCardsAcrossSources,
	overlayMergedEmploymentHistory,
	resolveEmploymentStatusTag,
	resolveOrderedSourcesFromDetail,
	sortByMostRecentStartDate,
} from '@/lib/dashboard-detail';

const silkDetail = {
	hasFinraData: false,
	hasSecData: true,
	finraNode: {
		basicInformation: { individualId: 1728992, firstName: 'JEFFERY', lastName: 'SILK', bcScope: 'NotInScope', iaScope: 'Active' },
		currentEmployments: [],
		previousEmployments: [],
		currentIAEmployments: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }],
		previousIAEmployments: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }],
	},
	sources: {
		finra: {
			bccontent: {
				basicInformation: { individualId: 1728992, firstName: 'JEFFERY', lastName: 'SILK', bcScope: 'NotInScope', iaScope: 'Active' },
				currentIAEmployments: [],
				previousIAEmployments: [],
				previousEmployments: [],
			},
		},
		sec: {
			iacontent: {
				basicInformation: { individualId: 1728992, firstName: 'JEFFERY', lastName: 'SILK', bcScope: 'NotInScope', iaScope: 'Active' },
				currentEmployments: [],
				previousEmployments: [],
				currentIAEmployments: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }],
				previousIAEmployments: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }],
			},
		},
	},
};

describe('dashboard detail source selection', () => {
	it('prefers SEC for IA-only Fisher employees instead of an empty FINRA NotInScope shell', () => {
		expect(resolveOrderedSourcesFromDetail(silkDetail, 'finra', ['finra', 'sec'])).toEqual(['sec', 'finra']);

		const payload = extractPayloadFromDetail(silkDetail, 'finra');
		expect(payload?.currentIAEmployments).toEqual([{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }]);
		expect(payload?.previousIAEmployments).toEqual([{ firmId: 107342, firmName: 'FISHER INVESTMENTS' }]);
	});

	it('overlays IA employment from merged detail onto a FINRA identity payload', () => {
		const overlaid = overlayMergedEmploymentHistory(silkDetail.sources.finra.bccontent, silkDetail);
		expect(overlaid.currentIAEmployments).toHaveLength(1);
		expect(overlaid.previousIAEmployments[0].firmName).toBe('FISHER INVESTMENTS');
	});

	it('unions FINRA BD jobs with SEC IA jobs from both sources', () => {
		const detail = {
			hasFinraData: true,
			hasSecData: true,
			sources: {
				finra: {
					bccontent: {
						basicInformation: { individualId: 1, bcScope: 'Active', iaScope: 'Active' },
						currentEmployments: [{ firmId: 999, firmName: 'BD FIRM', registrationBeginDate: '01/01/2020' }],
						currentIAEmployments: [],
					},
				},
				sec: {
					iacontent: {
						basicInformation: { individualId: 1, bcScope: 'Active', iaScope: 'Active' },
						currentEmployments: [],
						currentIAEmployments: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '11/05/2025' }],
					},
				},
			},
		};
		const payload = extractPayloadFromDetail(detail, 'finra');
		expect(payload?.currentEmployments).toEqual([{ firmId: 999, firmName: 'BD FIRM', registrationBeginDate: '01/01/2020' }]);
		expect(payload?.currentIAEmployments).toEqual([{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '11/05/2025' }]);
	});
});

describe('merge employment cards across FINRA and SEC', () => {
	it('merges the same firm into one card when dates are within a week', () => {
		const merged = mergeEmploymentCardsAcrossSources({
			finra: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '11/01/2025' }],
			sec: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '11/05/2025' }],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].firmId).toBe(107342);
		expect(merged[0].sourceTags).toEqual(['FINRA', 'SEC']);
	});

	it('keeps two cards for the same CRD when dates differ by more than a week', () => {
		const merged = mergeEmploymentCardsAcrossSources({
			finra: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '09/08/2010', registrationEndDate: '10/28/2025' }],
			sec: [{ firmId: 107342, firmName: 'FISHER INVESTMENTS', registrationBeginDate: '11/05/2025' }],
		});
		expect(merged).toHaveLength(2);
		expect(merged.every((row) => String(row.firmId) === '107342')).toBe(true);
		expect(merged.map((row) => row.sourceTags).flat()).toEqual(['FINRA', 'SEC']);
	});
});

describe('sortByMostRecentStartDate', () => {
	it('puts the most recent hire first and missing dates last', () => {
		expect(
			sortByMostRecentStartDate([
				{ name: 'old', startDate: '3/7/2003' },
				{ name: 'missing' },
				{ name: 'new', startDate: '4/9/2018' },
			]).map((row) => row.name),
		).toEqual(['new', 'old', 'missing']);
	});
});

describe('resolveEmploymentStatusTag', () => {
	it('returns Active when row has active firmBCScope or firmIAScope even if previous employment', () => {
		expect(resolveEmploymentStatusTag({ firmBCScope: 'ACTIVE', firmIAScope: 'ACTIVE' })).toBe('Active');
		expect(resolveEmploymentStatusTag({ firmBCScope: 'ACTIVE', firmIAScope: 'NOTINSCOPE' })).toBe('Active');
		expect(resolveEmploymentStatusTag({ firmBCScope: 'NOTINSCOPE', firmIAScope: 'ACTIVE' })).toBe('Active');
	});

	it('returns Active when cached firm info is active', () => {
		expect(resolveEmploymentStatusTag({ firmBCScope: 'NOTINSCOPE' }, { isActive: true })).toBe('Active');
		expect(resolveEmploymentStatusTag({}, { bcScope: 'Active', iaScope: 'NotInScope' })).toBe('Active');
		expect(resolveEmploymentStatusTag({}, { firmStatus: 'approved' })).toBe('Active');
	});

	it('returns Inactive when firm scope indicates inactive or terminated', () => {
		expect(resolveEmploymentStatusTag({ firmBCScope: 'INACTIVE', firmIAScope: 'TERMINATED' })).toBe('Inactive');
		expect(resolveEmploymentStatusTag({}, { bcScope: 'Inactive', iaScope: 'Terminated', isActive: false })).toBe('Inactive');
	});

	it('respects explicit statusTag if not "Inactive"', () => {
		expect(resolveEmploymentStatusTag({ statusTag: 'Pending' })).toBe('Pending');
	});
});

