import { readFile, unlink } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedisGet, mockRedisSet, mockRedisExists, mockSetStringIfValid, mockAccess, mockReadFile } = vi.hoisted(() => ({
	mockRedisGet: vi.fn(),
	mockRedisSet: vi.fn(),
	mockRedisExists: vi.fn(),
	mockSetStringIfValid: vi.fn(),
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
	Redis: vi.fn().mockImplementation(() => ({
		get: mockRedisGet,
		set: mockRedisSet,
		exists: mockRedisExists,
		type: vi.fn().mockResolvedValue('string'),
	})),
}));

vi.mock('@/lib/redisCache', () => ({
	setStringIfValid: mockSetStringIfValid,
}));

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		access: mockAccess,
		readFile: mockReadFile,
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	};
});

import { RECENT_SEEDS_FILE } from '@/lib/constants';
import { getRecentSeedsFromStore, rememberRecentSeed, saveRecentSeedsToStore, toCompactNode } from '@/lib/graphStore';

beforeEach(() => {
	mockRedisGet.mockReset();
	mockRedisSet.mockReset();
	mockRedisExists.mockReset();
	mockSetStringIfValid.mockReset();
	mockAccess.mockReset();
	mockReadFile.mockReset();
	mockRedisGet.mockResolvedValue(null);
	mockRedisSet.mockResolvedValue('OK');
	mockRedisExists.mockResolvedValue(0);
	mockSetStringIfValid.mockResolvedValue('written');
	mockAccess.mockResolvedValue(undefined);
	mockReadFile.mockResolvedValue(JSON.stringify({ nodes: [{ id: 'person:123', label: 'Ada', group: 'individual' }], links: [], meta: { generated: 'test' } }));
});

async function withRecentSeedsFileRestore(run: () => Promise<void>) {
	const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
	const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;

	let originalContents: string | null = null;
	try {
		originalContents = await readFile(RECENT_SEEDS_FILE, 'utf-8');
	} catch {
		originalContents = null;
	}

	try {
		await run();
	} finally {
		if (originalContents === null) {
			await unlink(RECENT_SEEDS_FILE).catch(() => {});
		} else {
			await saveRecentSeedsToStore(JSON.parse(originalContents));
		}

		if (typeof previousRedisUrl === 'string') process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
		else delete process.env.UPSTASH_REDIS_REST_URL;
		if (typeof previousRedisToken === 'string') process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
		else delete process.env.UPSTASH_REDIS_REST_TOKEN;
	}
}

describe('graphStore recent seed ordering', () => {
	it('treats higher CRDs as newer recent seeds', async () => {
		await withRecentSeedsFileRestore(async () => {
			await saveRecentSeedsToStore({
				individualIds: ['100', '400', '250'],
				firmIds: ['12', '88', '20'],
				updatedAt: new Date().toISOString(),
			});

			await rememberRecentSeed('individual', '350');
			await rememberRecentSeed('firm', '99');

			const recentSeeds = await getRecentSeedsFromStore();
			expect(recentSeeds.individualIds.slice(0, 4)).toEqual(['400', '350', '250', '100']);
			expect(recentSeeds.firmIds.slice(0, 4)).toEqual(['99', '88', '20', '12']);
		});
	});

	it('returns the disk graph without waiting for Redis sync when the shared cache is missing', async () => {
		const { getFullGraph } = await import('@/lib/graphStore');
		mockSetStringIfValid.mockImplementation(() => new Promise(() => {}));

		const graph = await getFullGraph();

		expect(graph.nodes.length).toBeGreaterThan(0);
		expect(graph.links).toBeDefined();
	});

	it('toCompactNode strips simulation keys and heavy nested detail records', () => {
		const heavyNode = {
			id: 'person:123',
			label: 'John Doe',
			group: 'individual',
			crd: '123',
			bcScope: 'Active',
			iaScope: 'NotInScope',
			hasFinraData: true,
			hasSecData: false,
			x: 100,
			y: 200,
			vx: 0.1,
			vy: 0.2,
			fx: null,
			fy: null,
			index: 5,
			_detailLoaded: true,
			basicInformation: {
				firstName: 'John',
				lastName: 'Doe',
				bcScope: 'Active',
				extraNoise: 'drop-me',
			},
			currentEmployments: [{ firmId: '1', firmName: 'Huge Firm Payload' }],
			currentIAEmployments: [{ firmId: '2' }],
			previousEmployments: [{ firmId: '3' }],
			previousIAEmployments: [{ firmId: '4' }],
			disclosures: [{ text: 'allegation' }],
			iaDisclosures: [{ text: 'ia allegation' }],
			brokerDetails: { exams: [] },
			stateExamCategory: ['Series 7'],
			principalExamCategory: ['Series 24'],
			productExamCategory: [],
			registeredSROs: [{ name: 'FINRA' }],
			directOwners: [{ crd: '999' }],
			indirectOwners: [],
			registrationCount: { approvedFinraRegistrationCount: 1 },
		};

		const compact = toCompactNode(heavyNode);

		expect(compact).toEqual({
			id: 'person:123',
			label: 'John Doe',
			group: 'individual',
			crd: '123',
			bcScope: 'Active',
			iaScope: 'NotInScope',
			hasFinraData: true,
			hasSecData: false,
			registrationCount: { approvedFinraRegistrationCount: 1 },
			basicInformation: {
				firstName: 'John',
				lastName: 'Doe',
				bcScope: 'Active',
			},
		});
		expect(compact.x).toBeUndefined();
		expect(compact.disclosures).toBeUndefined();
		expect(compact.directOwners).toBeUndefined();
		expect(compact.currentEmployments).toBeUndefined();
		expect(compact.previousEmployments).toBeUndefined();
		expect(compact.currentIAEmployments).toBeUndefined();
		expect(compact.previousIAEmployments).toBeUndefined();
	});
});
