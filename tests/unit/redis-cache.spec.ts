import { describe, expect, it } from 'vitest';
import { compressPayload } from '@/lib/redisCache';

describe('redis cache compression', () => {
	it('leaves simple numeric ID arrays uncompressed', () => {
		const value = JSON.stringify(['7820054', '6445278', '6114488']);
		expect(compressPayload(value)).toBe(value);
	});

	it('still compresses large non-array payloads', () => {
		const value = 'x'.repeat(6000);
		const result = compressPayload(value);
		expect(result).toMatch(/^br:/);
	});
});
