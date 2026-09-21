import { describe, expect, it } from 'vitest';
import { buildJsonDisplayTree } from '../../src/lib/dashboard-json';

describe('buildJsonDisplayTree', () => {
	it('turns nested objects and arrays into card-friendly tree nodes', () => {
		const tree = buildJsonDisplayTree({
			name: 'Parker Crane',
			registrations: [{ status: 'active' }, { status: 'pending' }],
		});

		expect(tree.type).toBe('object');
		expect(tree.children?.map((child) => child.key)).toEqual(['name', 'registrations']);
		expect(tree.children?.[1]?.type).toBe('array');
		expect(tree.children?.[1]?.children?.[0]?.children?.[0]?.value).toBe('active');
	});
});
