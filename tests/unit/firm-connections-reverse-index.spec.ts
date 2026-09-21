import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, upsertMock, rememberMock } = vi.hoisted(() => {
	const mockRedis = {
		get: vi.fn(),
		set: vi.fn(),
		scan: vi.fn(),
		del: vi.fn(),
	};
	const upsertMock = vi.fn(async () => ({ firmsTouched: ['7691'], firmsSkippedUnchanged: [] }));
	const rememberMock = vi.fn(async () => {});
	return { mockRedis, upsertMock, rememberMock };
});

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
	setStringIfValid: vi.fn(async () => 'written'),
	decompressPayload: (value: string) => value,
}));

vi.mock('@/lib/crdLog', () => ({
	rememberCrdLogEntries: rememberMock,
}));

vi.mock('@/lib/graphConnections', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/graphConnections')>();
	return {
		...actual,
		upsertIndividualIntoEmployerFirmConnections: upsertMock,
	};
});

import { runFirmConnectionsReverseIndexPass } from '@/lib/firmConnectionsReverseIndex';

describe('runFirmConnectionsReverseIndexPass', () => {
	beforeEach(() => {
		mockRedis.get.mockReset();
		mockRedis.set.mockReset();
		mockRedis.scan.mockReset();
		mockRedis.del.mockReset();
		upsertMock.mockClear();
		rememberMock.mockClear();
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === 'finra:individual:1085996') {
				return JSON.stringify({
					hits: {
						hits: [
							{
								_source: {
									content: JSON.stringify({
										basicInformation: { individualId: 1085996, firstName: 'Timothy', lastName: 'Register' },
										previousEmployments: [
											{
												firmId: 7691,
												firmName: 'MERRILL',
												registrationBeginDate: '12/21/1982',
												registrationEndDate: '6/17/1983',
											},
										],
									}),
								},
							},
						],
					},
				});
			}
			return null;
		});
		mockRedis.scan.mockResolvedValue(['0', ['finra:individual:1085996']]);
		mockRedis.set.mockResolvedValue('OK');
	});

	it('scans redis individuals and upserts employer firm-connections without external APIs', async () => {
		const result = await runFirmConnectionsReverseIndexPass({ batchSize: 10, maxFirmWrites: 10, resetCursor: true });
		expect(result.ok).toBe(true);
		expect(result.redisOnly).toBe(true);
		expect(result.individualsProcessed).toBe(1);
		expect(result.individualsWithEmployment).toBe(1);
		expect(upsertMock).toHaveBeenCalled();
		expect(mockRedis.set).not.toHaveBeenCalled();
		expect(rememberMock).toHaveBeenCalled();
	});
});
