import { describe, expect, it } from 'vitest';
import {
	isGenericDisplayName,
	isGenericFirmDisplayName,
	isGenericPersonDisplayName,
	preferNonGenericDisplayName,
} from '@/lib/displayNameGuards';
import { connectionNeedsDisplayEnrichment, preferRicherPersonName } from '@/lib/graphConnections';
import { buildParentFirmSummaryLinks } from '@/lib/finra-graph/externalLinks';

describe('display name guards', () => {
	it('flags Person/Individual/Node CRD placeholders as generic', () => {
		expect(isGenericPersonDisplayName('Person 2380166')).toBe(true);
		expect(isGenericPersonDisplayName('Individual 2380166')).toBe(true);
		expect(isGenericPersonDisplayName('Node person:2380166')).toBe(true);
		expect(isGenericPersonDisplayName('person:2380166')).toBe(true);
		expect(isGenericPersonDisplayName('CRD# 2380166')).toBe(true);
		expect(isGenericPersonDisplayName('WILLIAM MICHAEL SHIELDS')).toBe(false);
	});

	it('flags Firm placeholders as generic', () => {
		expect(isGenericFirmDisplayName('Firm 19801')).toBe(true);
		expect(isGenericFirmDisplayName('Node firm:19801')).toBe(true);
		expect(isGenericFirmDisplayName('BGC FINANCIAL, L.P.')).toBe(false);
	});

	it('prefers a real name over a generic placeholder', () => {
		expect(preferNonGenericDisplayName('Person 2380166', 'WILLIAM MICHAEL SHIELDS')).toBe('WILLIAM MICHAEL SHIELDS');
		expect(preferRicherPersonName('Person 2380166', 'WILLIAM MICHAEL SHIELDS')).toBe('WILLIAM MICHAEL SHIELDS');
		expect(preferRicherPersonName('WILLIAM MICHAEL SHIELDS', 'Individual 2380166')).toBe('WILLIAM MICHAEL SHIELDS');
	});

	it('connection enrichment always re-checks generic person names', () => {
		expect(
			connectionNeedsDisplayEnrichment({
				individualId: '2380166',
				name: 'Person 2380166',
				relationship: 'Current registration',
				isCurrent: true,
				evidence: ['display-enriched'],
			}),
		).toBe(true);
		expect(
			connectionNeedsDisplayEnrichment({
				individualId: '2380166',
				name: 'WILLIAM MICHAEL SHIELDS',
				relationship: 'Current registration',
				isCurrent: true,
				address: 'Red Bank, NJ',
				evidence: ['display-enriched'],
			}),
		).toBe(false);
		expect(isGenericDisplayName('Individual 1', 'individual')).toBe(true);
	});

	it('omits parent firm SEC AdvisorInfo link for BD-only employers (Shields / BGC pattern)', () => {
		const links = buildParentFirmSummaryLinks({
			bcScope: 'Active',
			iaScope: 'NotInScope',
			currentEmployments: [
				{
					firmId: '19801',
					firmName: 'BGC FINANCIAL, L.P.',
					firmBCScope: 'ACTIVE',
					firmIAScope: 'NOTINSCOPE',
					bdSECNumber: '39012',
				},
			],
		});
		expect(links.some((link) => link.className === 'bc')).toBe(true);
		expect(links.some((link) => link.className === 'sec')).toBe(false);
	});

	it('keeps parent firm SEC AdvisorInfo link when a real IA SEC number is present', () => {
		const links = buildParentFirmSummaryLinks({
			bcScope: 'Active',
			currentEmployments: [{ firmId: '37404', firmIAScope: 'ACTIVE' }],
			iaSecNumber: '8-47739',
			basicInformation: { iaSECNumber: '8-47739' },
		});
		expect(links.find((link) => link.className === 'sec')?.href).toBe('https://adviserinfo.sec.gov/firm/summary/8-47739');
	});
});
