import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockRedis } = vi.hoisted(() => ({
	mockRedis: {
		get: vi.fn(),
		set: vi.fn(),
		del: vi.fn(),
	},
}));

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
	compressPayload: (value: string) => value,
	decompressPayload: (value: string) => value,
}));

vi.mock('@/lib/redisAvailability', () => ({
	canWriteToRedis: () => true,
	isRedisCacheOnly: () => false,
}));

import { recordFirmReference, recordOwnerReferencesForFirm } from '@/lib/ownerReferenceIndex';

describe('recordFirmReference', () => {
	let tempDir: string;

	beforeEach(async () => {
		mockRedis.get.mockReset();
		mockRedis.set.mockReset();
		mockRedis.del.mockReset();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-live-crd-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('skips live firm CRDs and removes stale owner-ref entries when a live detail already exists', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === 'finra:firm:9321') return '{"ok":true}';
			return null;
		});
		mockRedis.del.mockResolvedValue(1);

		await recordFirmReference({
			crd: '9321',
			firmName: 'MERRILL',
			name: 'Timothy Register',
			parentCrd: '1085996',
			parentType: 'individual',
		});

		expect(mockRedis.get).toHaveBeenCalledWith('finra:firm:9321');
		expect(mockRedis.del).toHaveBeenCalledWith(
			'non-live-crds:firm:9321',
			'owner-ref:firm:9321',
		);
		expect(mockRedis.set).not.toHaveBeenCalled();
	});

	it('writes scraped-only firm references that are not already live', async () => {
		mockRedis.get.mockResolvedValue(null);

		await recordFirmReference({
			crd: '999991',
			firmName: 'SCRAPED FIRM',
			name: 'Timothy Register',
			parentCrd: '1085996',
			parentType: 'individual',
		});

		expect(mockRedis.set).toHaveBeenCalledWith(
			'non-live-crds:firm:999991',
			expect.any(String),
			{ ex: expect.any(Number) },
		);
	});

	it('does not treat an empty local search result as a live record', async () => {
		mockRedis.get.mockResolvedValue(null);
		const localResultPath = path.join(tempDir, 'data', 'national', 'brokercheck.finra.org');
		await fs.mkdir(localResultPath, { recursive: true });
		await fs.writeFile(
			path.join(localResultPath, 'api.brokercheck.finra.org_search_individual_5972432.json'),
			JSON.stringify({ hits: { total: 0, hits: [] } }),
			'utf8',
		);

		await recordOwnerReferencesForFirm({
			parentCrd: '7691',
			firmName: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED',
			owners: [{
				legalName: 'HEATON, DAVID CARLETON JR',
				position: 'CHIEF LEGAL OFFICER',
				bcScope: 'NotInScope',
				crdNumber: '5972432',
			}],
		});

		expect(mockRedis.set).toHaveBeenCalledWith(
			'non-live-crds:individual:5972432',
			expect.any(String),
			{ ex: expect.any(Number) },
		);
	});

	it('creates a legacy owner-ref entry only for direct owners explicitly marked NotInScope', async () => {
		mockRedis.get.mockResolvedValue(null);

		await recordOwnerReferencesForFirm({
			parentCrd: '7691',
			firmName: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED',
			owners: [{
				legalName: 'HEATON, DAVID CARLETON JR',
				position: 'CHIEF LEGAL OFFICER',
				bcScope: 'NotInScope',
				crdNumber: '5972432',
			}],
		});

		expect(mockRedis.set).toHaveBeenCalledWith(
			'non-live-crds:individual:5972432',
			expect.any(String),
			{ ex: expect.any(Number) },
		);
	});
});
