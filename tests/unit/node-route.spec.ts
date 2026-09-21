import { describe, expect, it } from 'vitest';
import { applyStickyParamsToUrl, buildNodeRouteHref, buildNodeRoutePath, getStickySearch, parseNodeIdFromPathname } from '../../src/lib/node-route';

describe('node route helpers', () => {
	it('builds graph-prefixed record paths for person and firm nodes', () => {
		expect(buildNodeRoutePath('person:8303401')).toBe('/individual/8303401');
		expect(buildNodeRoutePath('firm:2602425')).toBe('/firm/2602425');
	});

	it('parses graph-prefixed and dashboard-prefixed record paths back into node identifiers', () => {
		expect(parseNodeIdFromPathname('/node/person-8303401')).toBe('person:8303401');
		expect(parseNodeIdFromPathname('/node/firm-2602425')).toBe('firm:2602425');
		expect(parseNodeIdFromPathname('/dashboard/individual/8303401')).toBe('person:8303401');
		expect(parseNodeIdFromPathname('/dashboard/firm/2602425')).toBe('firm:2602425');
	});

	it('keeps disable_analytics and safe_gpu sticky across node hrefs', () => {
		expect(getStickySearch('?disable_analytics=1&safe_gpu=0&selected=person:1')).toBe('?disable_analytics=1&safe_gpu=0');
		expect(applyStickyParamsToUrl('/firm/705', '?disable_analytics=1&safe_gpu=0')).toBe('/firm/705?disable_analytics=1&safe_gpu=0');
		expect(buildNodeRouteHref('firm:705', '?disable_analytics=1&safe_gpu=0')).toBe('/firm/705?disable_analytics=1&safe_gpu=0');
	});
});
