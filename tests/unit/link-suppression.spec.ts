import { describe, expect, it } from 'vitest';

import { shouldSuppressSecLink, shouldSuppressFinraLink, SUPPRESSED_SEC_FIRM_IDS, SUPPRESSED_SEC_INDIV_IDS } from '../../src/lib/finra-graph/linkSuppression';

describe('SEC/FINRA link suppression', () => {
	it('suppresses SEC links for the ADAM E. GILBERT firm record', () => {
		expect(SUPPRESSED_SEC_FIRM_IDS.has('2001')).toBe(true);
		expect(shouldSuppressSecLink({ firmId: '2001', group: 'firm' }, 'firm')).toBe(true);
	});

	it('suppresses SEC links for known bad individual IDs', () => {
		expect(SUPPRESSED_SEC_INDIV_IDS.has('18040')).toBe(true);
		expect(shouldSuppressSecLink({ crd: '18040', group: 'individual' }, 'individual')).toBe(true);
	});

	it('honors explicit per-node SEC suppression flags', () => {
		expect(shouldSuppressSecLink({ suppressedExternalLinks: ['SEC'] }, 'firm')).toBe(true);
	});

	it('honors explicit per-node FINRA suppression flags', () => {
		expect(shouldSuppressFinraLink({ suppressedExternalLinks: ['FINRA'] })).toBe(true);
	});
});
