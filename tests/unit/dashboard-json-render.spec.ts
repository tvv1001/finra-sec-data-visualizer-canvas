import { describe, expect, it } from 'vitest';

import { normalizeRenderablePayload, renderJsonForDisplay } from '../../src/lib/dashboard-json';

describe('dashboard JSON rendering helpers', () => {
	it('parses JSON-like strings before pretty-printing them', () => {
		const rendered = renderJsonForDisplay('{"basicInformation":{"name":"Jane Doe"}}');

		expect(rendered).toContain('"basicInformation"');
		expect(rendered).toContain('"name": "Jane Doe"');
		expect(rendered).not.toContain('"{\\"basicInformation\\"');
	});

	it('normalizes nested JSON wrappers in payloads for display', () => {
		const normalized = normalizeRenderablePayload({
			content: '{"legalName":"Acme","status":"active"}',
			iacontent: '{"iaScope":"approved"}',
			meta: '{"source":"sec"}',
		});

		expect(normalized).toEqual({
			legalName: 'Acme',
			status: 'active',
			iaScope: 'approved',
			source: 'sec',
		});
		expect(normalized).not.toHaveProperty('meta');
	});
});
