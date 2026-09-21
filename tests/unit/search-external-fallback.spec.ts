import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchExternalFallback } from '@/lib/searchExternalFallback';

describe('searchExternalFallback', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.useFakeTimers();
		global.fetch = vi.fn();
		process.env.EXTERNAL_API_ENABLED = '1';
	});

	afterEach(() => {
		vi.useRealTimers();
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		delete process.env.EXTERNAL_API_ENABLED;
	});

	it('queries external BrokerCheck and parses results to LocalSearchResponse, triggering background calls', async () => {
		const mockSearchResponse = {
			hits: {
				total: 150,
				hits: [
					{
						_id: 'person-5142052',
						_source: {
							ind_source_id: '5142052',
							ind_firstname: 'Jay',
							ind_lastname: 'Nova',
						},
					},
					{
						_id: 'person-1234567',
						_source: {
							ind_source_id: '1234567',
							ind_firstname: 'John',
							ind_lastname: 'Doe',
						},
					},
				],
			},
		};

		// Mock first call for search, subsequent calls for details prefetching
		vi.mocked(global.fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => mockSearchResponse,
			} as Response)
			// Mock details prefetching calls
			.mockResolvedValue({
				ok: true,
				json: async () => ({ found: true }),
			} as Response);

		const result = await searchExternalFallback('finra', 'individual', 'jay nova', 'http://localhost:3000');

		expect(result).not.toBeNull();
		expect(result?.total).toBe(150);
		expect(result?.hits?.hits).toHaveLength(2);
		expect(result?.hits?.hits[0]._id).toBe('person:5142052');
		expect(result?.results).toHaveLength(2);
		expect(result?.results[0].ind_firstname).toBe('Jay');

		// Assert fetch was called with the correct BrokerCheck URL
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('https://api.brokercheck.finra.org/search/individual?query=jay%20nova&hl=true&includePrevious=true&nrows=100'),
			expect.any(Object)
		);

		// Fast-forward to run background tasks
		await vi.runAllTimersAsync();

		// Check if background caching requests were made for the 2 search result CRDs
		expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/api/finra/individual/5142052');
		expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/api/finra/individual/1234567');
	});
});
