import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
}));

import { getFullGraph } from '@/lib/graphStore';
import { searchGraphFallback } from '@/lib/searchGraphFallback';

describe('graph search fallback', () => {
	beforeEach(() => {
		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: 'person:1222513',
					label: 'Ronald Perry Mason',
					group: 'individual',
					crd: '1222513',
				},
				{
					id: 'person:999999',
					label: 'Randy Mayson',
					group: 'individual',
					crd: '999999',
				},
				{
					id: 'firm:39914',
					label: 'Mason Example Firm',
					group: 'firm',
					firmId: '39914',
				},
			],
			links: [],
		});
	});

	it('matches free-text node names like mason', async () => {
		const result = await searchGraphFallback('finra', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => String(doc.id || '') === 'person:1222513')).toBe(true);
		expect(result.response.docs.some((doc) => String(doc.id || '') === 'person:999999')).toBe(false);
	});

	it('treats mason as a strict term instead of fuzzy matching similar spellings', async () => {
		const result = await searchGraphFallback('finra', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBe(1);
		expect(result.response.docs[0]?.id).toBe('person:1222513');
	});

	it('treats bryan as a strict term instead of fuzzy matching similar spellings', async () => {
		vi.mocked(getFullGraph).mockResolvedValueOnce({
			nodes: [
				{
					id: 'person:300001',
					label: 'Michael Bryan',
					group: 'individual',
					crd: '300001',
				},
				{
					id: 'person:300002',
					label: 'Michele Bryanne',
					group: 'individual',
					crd: '300002',
				},
			],
			links: [],
		});

		const result = await searchGraphFallback('finra', 'individual', 'bryan', { limit: 1000 });

		expect(result.total).toBe(1);
		expect(result.response.docs[0]?.id).toBe('person:300001');
	});

	it('matches only top-level CRDs', async () => {
		const result = await searchGraphFallback('finra', 'individual', '1222513', { limit: 1000 });

		expect(result.total).toBe(1);
		expect(result.response.docs[0]?.id).toBe('person:1222513');
	});

	it('does not substring-match numeric identifiers in graph fallback', async () => {
		const result = await searchGraphFallback('finra', 'individual', '122251', { limit: 1000 });

		expect(result.total).toBe(0);
	});
});
