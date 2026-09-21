import { describe, expect, it, vi } from 'vitest';

import {
	backfillPrimedCacheToRedis,
	buildPrimedBackfillEntries,
	normalizeBackfillTtlSeconds,
	normalizePrimedRedisRecordKey,
	resolvePrimedBundleNames,
} from '../../src/lib/primedRedisSync';

describe('normalizePrimedRedisRecordKey', () => {
	it('strips search-query suffixes from cached record keys', () => {
		expect(normalizePrimedRedisRecordKey('finra:individual:123:hl=true&includePrevious=true&wt=json')).toBe('finra:individual:123');
		expect(normalizePrimedRedisRecordKey('sec:firm:987:wt=json')).toBe('sec:firm:987');
	});
});

describe('resolvePrimedBundleNames', () => {
	it('keeps only supported bundle names and falls back to all when input is empty', () => {
		expect(resolvePrimedBundleNames(['finra-individual', 'SEC-FIRM', 'nope'])).toEqual(['finra-individual', 'sec-firm']);
		expect(resolvePrimedBundleNames('')).toEqual(['finra-individual', 'sec-individual', 'finra-firm', 'sec-firm']);
	});
});

describe('normalizeBackfillTtlSeconds', () => {
	it('defaults native backfill writes to persistent Redis records', () => {
		expect(normalizeBackfillTtlSeconds()).toBe(0);
		expect(normalizeBackfillTtlSeconds(null)).toBe(0);
		expect(normalizeBackfillTtlSeconds(-1)).toBe(0);
		expect(normalizeBackfillTtlSeconds(3600)).toBe(3600);
	});
});

describe('buildPrimedBackfillEntries', () => {
	it('creates deterministic entries with normalized target keys', () => {
		const entries = buildPrimedBackfillEntries(
			{
				'finra-individual': {
					'finra:individual:2:hl=true&includePrevious=true&wt=json': { id: 2 },
					'finra:individual:1:hl=true&includePrevious=true&wt=json': { id: 1 },
				},
				'sec-firm': {
					'sec:firm:9:wt=json': { id: 9 },
				},
			},
			['finra-individual', 'sec-firm'],
		);

		expect(entries.map((entry) => `${entry.bundleName}:${entry.targetKey}`)).toEqual([
			'finra-individual:finra:individual:1',
			'finra-individual:finra:individual:2',
			'sec-firm:sec:firm:9',
		]);
	});
});

describe('backfillPrimedCacheToRedis', () => {
	it('supports dry-run pagination without writing records', async () => {
		const writeRecord = vi.fn();
		const result = await backfillPrimedCacheToRedis(
			{ bundleNames: ['finra-individual', 'sec-firm'], maxRecords: 2, cursor: 1, dryRun: true },
			{
				loadBundle: async (bundleName) => {
					if (bundleName === 'finra-individual') {
						return {
							'finra:individual:100:hl=true&includePrevious=true&wt=json': { name: 'A' },
							'finra:individual:101:hl=true&includePrevious=true&wt=json': { name: 'B' },
						};
					}
					if (bundleName === 'sec-firm') {
						return {
							'sec:firm:200:wt=json': { name: 'C' },
						};
					}
					return {};
				},
				writeRecord,
			},
		);

		expect(result.totalRecords).toBe(3);
		expect(result.scanned).toBe(2);
		expect(result.nextCursor).toBeNull();
		expect(result.records.map((record) => record.targetKey)).toEqual(['finra:individual:101', 'sec:firm:200']);
		expect(result.records.every((record) => record.action === 'would-write')).toBe(true);
		expect(writeRecord).not.toHaveBeenCalled();
	});

	it('skips existing records by default and writes only missing ones', async () => {
		const writeRecord = vi.fn(async () => 'written');
		const result = await backfillPrimedCacheToRedis(
			{ bundleNames: ['finra-individual'], maxRecords: 10 },
			{
				loadBundle: async () => ({
					'finra:individual:100:hl=true&includePrevious=true&wt=json': { name: 'A' },
					'finra:individual:101:hl=true&includePrevious=true&wt=json': { name: 'B' },
				}),
				hasExistingKey: async (key) => key === 'finra:individual:100',
				writeRecord,
			},
		);

		expect(result.written).toBe(1);
		expect(result.skippedExisting).toBe(1);
		expect(result.failed).toBe(0);
		expect(writeRecord).toHaveBeenCalledTimes(1);
		expect(writeRecord).toHaveBeenCalledWith('finra:individual:101', JSON.stringify({ name: 'B' }), 0);
	});

	it('overwrites existing keys when requested', async () => {
		const writeRecord = vi.fn(async () => 'written');
		const result = await backfillPrimedCacheToRedis(
			{ bundleNames: ['sec-firm'], overwrite: true },
			{
				loadBundle: async () => ({
					'sec:firm:200:wt=json': { name: 'Firm 200' },
				}),
				hasExistingKey: async () => true,
				writeRecord,
			},
		);

		expect(result.skippedExisting).toBe(0);
		expect(result.written).toBe(1);
		expect(result.records[0]).toMatchObject({
			targetKey: 'sec:firm:200',
			action: 'written',
		});
	});
});
