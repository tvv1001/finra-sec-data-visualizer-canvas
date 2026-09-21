import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
	searchLocalIndex,
	cleanSearchQuery,
	extractSearchQueries,
	searchQueriesSequentially,
	hydrateFirmNodeLabelsFromSearchSidecar,
	hydrateNodeConnectionCountsFromSearchSidecar,
	countIndividualConnectionsFromSearchHit,
	attachFirmConnectionCountsFromFlatfiles,
	lookupFirmNamesFromSearchSidecar,
	clearSearchIndexCache,
} from '@/lib/localSearch';
import { getSearchIndexFilePath } from '@/lib/searchDataPaths';

async function withTempSearchIndex(fileName: string, content: string | Buffer, run: (root: string) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'finra-search-index-'));
	const indexDir = path.join(root, 'data', 'national');
	await mkdir(indexDir, { recursive: true });
	await writeFile(path.join(indexDir, fileName), content);
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe('local search indexes', () => {
	afterEach(() => {
		clearSearchIndexCache();
	});

	it('extracts a CRD from pasted name and CRD text', () => {
		expect(cleanSearchQuery('Jane Doe :: CRD# 12345')).toBe('12345');
		expect(cleanSearchQuery('Jane Doe :: 12345')).toBe('12345');
	});

	it('extracts every CRD from pasted multi-entry lists', () => {
		expect(extractSearchQueries('Alice Example :: CRD# 12345\nBob Example :: CRD# 67890')).toEqual(['12345', '67890']);
		expect(cleanSearchQuery('Alice Example :: CRD# 12345\nBob Example :: CRD# 67890')).toBe('12345');
	});

	it('extracts numeric CRDs separated by spaces or newlines', () => {
		expect(extractSearchQueries('4098470 6805343 6149705')).toEqual(['4098470', '6805343', '6149705']);
		expect(extractSearchQueries('4098470\n6805343\n6149705')).toEqual(['4098470', '6805343', '6149705']);
	});

	it('extracts comma-separated name queries as separate searches', () => {
		expect(extractSearchQueries('mcgee,hopper,musgrove,mitchel')).toEqual(['mcgee', 'hopper', 'musgrove', 'mitchel']);
		expect(extractSearchQueries('jane doe, john smith')).toEqual(['jane doe', 'john smith']);
	});

	it('extracts CRDs from mixed pasted content with names and punctuation', () => {
		expect(extractSearchQueries('Brett Godwin :: CRD# 8100932\nAndrew Karp :: CRD# 7647370\nA note with SEC# 44319 and other text')).toEqual(['8100932', '7647370']);
	});

	it('extracts CRDs from a large pasted block with firm lines and SEC markers', () => {
		const input = [
			'John Matthew Godwin :: CRD# 4733934',
			'MADISON CAPITAL MARKETS LLC :: CRD# 332196',
			'AMERICAN FRONTEER FINANCIAL CORPORATION :: CRD# 1398 / SEC# 18200',
			'Node firm:165013 :: CRD# 165013',
			'ACCESS SECURITIES, LLC :: CRD# 22455 / SEC# 39729',
			'Danna Beth Fuqua :: CRD# 4774182',
			'James E Pass :: CRD# 1563352',
		].join('\n');

		expect(extractSearchQueries(input)).toEqual(['4733934', '332196', '1398', '165013', '22455', '4774182', '1563352']);
	});

	it('moves to the next query when an earlier one has no results', async () => {
		const queries = extractSearchQueries('Jane Doe :: CRD# 11111\nJohn Doe :: CRD# 22222');
		let attemptedQueries: string[] = [];
		const result = await searchQueriesSequentially(
			queries,
			async (query) => {
				attemptedQueries.push(query);
				return query === '11111' ? { total: 0, results: [] } : { total: 1, results: [{ id: query }] };
			},
			(value) => Boolean((value as { total?: number } | null | undefined)?.total),
		);

		expect(attemptedQueries).toEqual(['11111', '22222']);
		expect(result).toEqual([{ total: 1, results: [{ id: '22222' }] }]);
	});

	it('looks up firm names from the gzip sidecar by CRD', async () => {
		const payload = JSON.stringify({
			generatedAt: '2026-01-01T00:00:00.000Z',
			bucket: 'finra:firm',
			docs: [
				{
					id: 'finra:firm:31194',
					type: 'firm',
					source: 'finra',
					nameSearchText: 'rbc capital markets',
					strictSearchText: 'rbc capital markets 31194',
					searchText: '31194 rbc capital markets',
					hit: {
						firm_id: '31194',
						firmId: '31194',
						firm_source_id: '31194',
						firm_name: 'RBC CAPITAL MARKETS, LLC',
						firmName: 'RBC CAPITAL MARKETS, LLC',
					},
				},
			],
		});

		await withTempSearchIndex('search-index.finra.firm.json.gz', gzipSync(Buffer.from(payload)), async (root) => {
			const names = await lookupFirmNamesFromSearchSidecar(['31194'], { seedRoots: [root] });
			expect(names.get('31194')).toBe('RBC CAPITAL MARKETS, LLC');

			const nodes: Array<{ id: string; group: string; label: string; firmId: string; firmName?: string }> = [
				{ id: 'firm:31194', group: 'firm', label: 'Firm 31194', firmId: '31194' },
			];
			await hydrateFirmNodeLabelsFromSearchSidecar(nodes, { seedRoots: [root] });
			expect(nodes[0].label).toBe('RBC CAPITAL MARKETS, LLC');
			expect(nodes[0].firmName).toBe('RBC CAPITAL MARKETS, LLC');
		});
	});

	it('counts unique firm connections from individual search hits', () => {
		expect(
			countIndividualConnectionsFromSearchHit({
				ind_connection_count: 12,
				ind_current_employments: [{ firmId: '1' }],
			}),
		).toBe(12);
		expect(
			countIndividualConnectionsFromSearchHit({
				ind_current_employments: [{ firmId: '10' }, { firm_id: '10' }],
				ind_previous_employments: [{ firmId: '20' }],
				ind_ia_previous_employments: [{ firmId: '30' }],
			}),
		).toBe(3);
	});

	it('hydrates knownConnectionCount onto person nodes from search sidecars', async () => {
		const payload = JSON.stringify({
			generatedAt: new Date().toISOString(),
			bucket: 'finra:individual',
			docs: [
				{
					id: 'finra:individual:4242',
					type: 'individual',
					source: 'finra',
					nameSearchText: 'test person',
					strictSearchText: 'test person',
					searchText: '4242 test person',
					hit: {
						ind_source_id: '4242',
						ind_crd: '4242',
						ind_firstname: 'Test',
						ind_lastname: 'Person',
						ind_connection_count: 7,
						ind_current_employments: [{ firmId: '1' }],
						ind_previous_employments: [{ firmId: '2' }, { firmId: '3' }],
					},
				},
			],
		});

		await withTempSearchIndex('search-index.finra.individual.json.gz', gzipSync(Buffer.from(payload)), async (root) => {
			const nodes: Array<{ id: string; group: string; crd: string; knownConnectionCount?: number }> = [
				{ id: 'person:4242', group: 'individual', crd: '4242' },
			];
			await hydrateNodeConnectionCountsFromSearchSidecar(nodes, { seedRoots: [root] });
			expect(nodes[0].knownConnectionCount).toBe(7);
		});
	});

	it('attaches firm knownConnectionCount from currentConnections only', () => {
		const nodes: Array<{ id: string; group: string; knownConnectionCount?: number }> = [{ id: 'firm:705', group: 'firm' }];
		attachFirmConnectionCountsFromFlatfiles(nodes);
		const known = Number(nodes[0].knownConnectionCount || 0);
		expect(known).toBeGreaterThan(0);
		// Guard against accidentally using current+previous (705 has hundreds of previous).
		expect(known).toBeLessThan(300);
	});

	it('returns FINRA individual results from the local index', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'paula branum', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000475');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('branum');
	});

	it('returns SEC firm results from the local index', async () => {
		const result = await searchLocalIndex('sec', 'firm', '39914', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.hits.hits.length).toBeGreaterThan(0);
		expect(result.response.docs[0]?.firm_id).toBe('39914');
		expect(String(result.response.docs[0]?.firm_name || '').toLowerCase()).toContain('westpark');
	});

	it('supports fuzzy matching on individual names', async () => {
		const result = await searchLocalIndex('finra', 'individual', 'ray bacala', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1000495');
		expect(String(result.response.docs[0]?.ind_lastname || '').toLowerCase()).toContain('baccala');
	});

	it('matches Mason as a whole word in first, middle, or last name', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.total).toBeLessThan(5000);
		expect(result.response.docs.some((doc) => /\bmason\b/i.test(`${doc.ind_firstname || ''} ${doc.ind_middlename || ''} ${doc.ind_lastname || ''} ${doc.label || ''}`))).toBe(true);
	});

	it('treats Mason as a strict term instead of fuzzy matching close spellings', async () => {
		await withTempSearchIndex(
			'search-index.sec.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-07T00:00:00.000Z',
				bucket: 'sec:individual',
				docs: [
					{
						id: 'sec:individual:1',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Ronald Mason',
						strictSearchText: 'Ronald Mason',
						searchText: '1 Ronald Mason',
						hit: {
							ind_source_id: '1',
							ind_firstname: 'Ronald',
							ind_lastname: 'Mason',
						},
					},
					{
						id: 'sec:individual:2',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Randy Mayson',
						strictSearchText: 'Randy Mayson',
						searchText: '2 Randy Mayson',
						hit: {
							ind_source_id: '2',
							ind_firstname: 'Randy',
							ind_lastname: 'Mayson',
						},
					},
				],
			}),
			async (root) => {
				const result = await searchLocalIndex('sec', 'individual', 'mason', { limit: 10, seedRoots: [root] });
				expect(result.total).toBe(1);
				expect(result.response.docs[0]?.ind_source_id).toBe('1');
			},
		);
	});

	it('allows state/street exact matches but blocks partial state or street matches', async () => {
		await withTempSearchIndex(
			'search-index.sec.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-07T00:00:00.000Z',
				bucket: 'sec:individual',
				docs: [
					{
						id: 'sec:individual:99',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Jane Doe',
						strictSearchText: 'Jane Doe Dallas Texas 123 Main Street',
						searchText: '99 Jane Doe Dallas Texas 123 Main Street',
						hit: {
							ind_source_id: '99',
							ind_firstname: 'Jane',
							ind_lastname: 'Doe',
							ind_current_employments: [{ state: 'Texas', street1: '123 Main Street', city: 'Dallas' }],
						},
					},
				],
			}),
			async (root) => {
				const exactState = await searchLocalIndex('sec', 'individual', 'texas', { limit: 10, seedRoots: [root] });
				const partialState = await searchLocalIndex('sec', 'individual', 'tex', { limit: 10, seedRoots: [root] });
				const exactStreet = await searchLocalIndex('sec', 'individual', '123 main street', { limit: 10, seedRoots: [root] });
				const partialStreet = await searchLocalIndex('sec', 'individual', 'main', { limit: 10, seedRoots: [root] });
				expect(exactState.total).toBe(1);
				expect(partialState.total).toBe(0);
				expect(exactStreet.total).toBe(1);
				expect(partialStreet.total).toBe(0);
			},
		);
	});

	it('treats Bryan as a strict term instead of fuzzy matching close spellings', async () => {
		await withTempSearchIndex(
			'search-index.sec.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-07T00:00:00.000Z',
				bucket: 'sec:individual',
				docs: [
					{
						id: 'sec:individual:3',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Michael Bryan',
						strictSearchText: 'Michael Bryan',
						searchText: '3 Michael Bryan',
						hit: {
							ind_source_id: '3',
							ind_firstname: 'Michael',
							ind_lastname: 'Bryan',
						},
					},
					{
						id: 'sec:individual:4',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Michele Bryanne',
						strictSearchText: 'Michele Bryanne',
						searchText: '4 Michele Bryanne',
						hit: {
							ind_source_id: '4',
							ind_firstname: 'Michele',
							ind_lastname: 'Bryanne',
						},
					},
				],
			}),
			async (root) => {
				const result = await searchLocalIndex('sec', 'individual', 'bryan', { limit: 10, seedRoots: [root] });
				expect(result.response.docs.some((doc) => String(doc.ind_source_id || '') === '3')).toBe(true);
			},
		);
	});

	it('matches the top-level full name when queried directly', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'Kevin PATRICK Butler', { limit: 10 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs.length).toBeGreaterThan(0);
	});

	it('includes firms whose alias names contain Mason', async () => {
		const result = await searchLocalIndex('sec', 'firm', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => String(doc.firm_id || '') === '39914')).toBe(true);
		expect(
			result.response.docs.some((doc) => {
				const aliases = [doc.otherNames, doc.firm_other_names, doc.previousNames, doc.previous_names].flat().filter(Boolean) as string[];
				return aliases.some((alias) => /\bmason\b/i.test(String(alias)));
			}),
		).toBe(true);
	});

	it('includes individuals whose alias or previous names contain Mason', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'mason', { limit: 1000 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs.some((doc) => /\bmason\b/i.test(`${doc.ind_firstname || ''} ${doc.ind_lastname || ''} ${doc.label || ''}`))).toBe(true);
	});

	it('matches past names and aliases for individuals', async () => {
		const result = await searchLocalIndex('sec', 'individual', 'lisa keverian', { limit: 5 });

		expect(result.total).toBeGreaterThan(0);
		expect(result.response.docs[0]?.ind_source_id).toBe('1001173');
		expect(result.response.docs[0]?.otherNames).toContain('LISA ANN KEVERIAN');
	});

	it('matches address text for regular queries', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-06T00:00:00.000Z',
				bucket: 'finra:individual',
				docs: [
					{
						id: 'finra:individual:1',
						type: 'individual',
						source: 'finra',
						nameSearchText: 'Alice Example',
						addressSearchText: '100 market street sydney australia',
						strictSearchText: 'Alice Example office address 100 Market Street Sydney Australia',
						searchText: '1 Alice Example',
						hit: {
							ind_source_id: '1',
							ind_crd: '1',
							ind_firstname: 'Alice',
							ind_lastname: 'Example',
						},
					},
				],
			}),
			async (root) => {
				const result = await searchLocalIndex('finra', 'individual', 'Sydney', { limit: 5, seedRoots: [root] });
				expect(result.total).toBe(1);
				expect(result.response.docs[0]?.ind_source_id).toBe('1');
			},
		);
	});

	it('matches a one-character-off address word when the address contains it', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-06T00:00:00.000Z',
				bucket: 'finra:individual',
				docs: [
					{
						id: 'finra:individual:2',
						type: 'individual',
						source: 'finra',
						nameSearchText: 'Bob Example',
						addressSearchText: '200 bay street toronto canada',
						strictSearchText: 'Bob Example office address 200 Bay Street Toronto Canada',
						searchText: '2 Bob Example',
						hit: {
							ind_source_id: '2',
							ind_crd: '2',
							ind_firstname: 'Bob',
							ind_lastname: 'Example',
						},
					},
				],
			}),
			async (root) => {
				const result = await searchLocalIndex('finra', 'individual', 'Torontp', { limit: 5, seedRoots: [root] });
				expect(result.total).toBe(1);
				expect(result.response.docs[0]?.ind_source_id).toBe('2');
			},
		);
	});

	it('matches airport-code words in address text', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-06T00:00:00.000Z',
				bucket: 'finra:individual',
				docs: [
					{
						id: 'finra:individual:3',
						type: 'individual',
						source: 'finra',
						nameSearchText: 'Casey Example',
						addressSearchText: '10 LAX airport road los angeles california',
						strictSearchText: 'Casey Example',
						searchText: '3 Casey Example',
						hit: {
							ind_source_id: '3',
							ind_crd: '3',
							ind_firstname: 'Casey',
							ind_lastname: 'Example',
						},
					},
				],
			}),
			async (root) => {
				const result = await searchLocalIndex('finra', 'individual', 'LAX', { limit: 5, seedRoots: [root] });
				expect(result.total).toBe(1);
				expect(result.response.docs[0]?.ind_source_id).toBe('3');
			},
		);
	});

	it('does not match address text for firm queries, matching name only', async () => {
		await withTempSearchIndex(
			'search-index.finra.firm.json',
			JSON.stringify({
				generatedAt: '2026-06-06T00:00:00.000Z',
				bucket: 'finra:firm',
				docs: [
					{
						id: 'finra:firm:999',
						type: 'firm',
						source: 'finra',
						nameSearchText: 'Alpha Capital',
						addressSearchText: '100 main street chicago illinois',
						strictSearchText: 'Alpha Capital',
						searchText: '999 Alpha Capital',
						hit: {
							firm_id: '999',
							firm_name: 'Alpha Capital',
						},
					},
				],
			}),
			async (root) => {
				const nameResult = await searchLocalIndex('finra', 'firm', 'Alpha', { limit: 5, seedRoots: [root] });
				expect(nameResult.total).toBe(1);
				expect(nameResult.response.docs[0]?.firm_id).toBe('999');

				const addressResult = await searchLocalIndex('finra', 'firm', 'Chicago', { limit: 5, seedRoots: [root] });
				expect(addressResult.total).toBe(0);
			},
		);
	});

	it('keeps Mc and O apostrophe names tightly ranked', async () => {
		await withTempSearchIndex(
			'search-index.sec.individual.json',
			JSON.stringify({
				generatedAt: '2026-06-06T00:00:00.000Z',
				bucket: 'sec:individual',
				docs: [
					{
						id: 'sec:individual:1',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Sean McAdam',
						addressSearchText: '1 harbor street boston massachusetts',
						strictSearchText: 'Sean McAdam',
						searchText: '1 Sean McAdam',
						hit: {
							ind_source_id: '1',
							ind_crd: '1',
							ind_firstname: 'Sean',
							ind_lastname: 'McAdam',
						},
					},
					{
						id: 'sec:individual:2',
						type: 'individual',
						source: 'sec',
						nameSearchText: 'Sean McAdams',
						addressSearchText: '2 harbor street boston massachusetts',
						strictSearchText: 'Sean McAdams',
						searchText: '2 Sean McAdams',
						hit: {
							ind_source_id: '2',
							ind_crd: '2',
							ind_firstname: 'Sean',
							ind_lastname: 'McAdams',
						},
					},
					{
						id: 'sec:individual:3',
						type: 'individual',
						source: 'sec',
						nameSearchText: "Sean O'Reilly",
						addressSearchText: '3 harbor street boston massachusetts',
						strictSearchText: "Sean O'Reilly",
						searchText: "3 Sean O'Reilly",
						hit: {
							ind_source_id: '3',
							ind_crd: '3',
							ind_firstname: 'Sean',
							ind_lastname: "O'Reilly",
						},
					},
					{
						id: 'sec:individual:4',
						type: 'individual',
						source: 'sec',
						nameSearchText: "Sean O'Reillys",
						addressSearchText: '4 harbor street boston massachusetts',
						strictSearchText: "Sean O'Reillys",
						searchText: "4 Sean O'Reillys",
						hit: {
							ind_source_id: '4',
							ind_crd: '4',
							ind_firstname: 'Sean',
							ind_lastname: "O'Reillys",
						},
					},
				],
			}),
			async (root) => {
				const mcResult = await searchLocalIndex('sec', 'individual', 'mcadam', { limit: 5, seedRoots: [root] });
				expect(mcResult.total).toBe(2);
				expect(mcResult.response.docs[0]?.ind_lastname).toBe('McAdam');
				expect(mcResult.response.docs[1]?.ind_lastname).toBe('McAdams');

				const oResult = await searchLocalIndex('sec', 'individual', "o'reilly", { limit: 5, seedRoots: [root] });
				expect(oResult.total).toBe(2);
				expect(oResult.response.docs[0]?.ind_lastname).toBe("O'Reilly");
				expect(oResult.response.docs[1]?.ind_lastname).toBe("O'Reillys");
			},
		);
	});

	it('resolves search index files from nested runtime roots', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({ generatedAt: '2026-06-06T00:00:00.000Z', bucket: 'finra:individual', docs: [] }),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [path.join(root, 'src', 'lib')]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json'));
			},
		);
	});

	it('prefers gzip search indexes when they are available', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json.gz',
			gzipSync(
				Buffer.from(
					JSON.stringify({
						generatedAt: '2026-06-06T00:00:00.000Z',
						bucket: 'finra:individual',
						docs: [],
					}),
				),
			),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [root]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json.gz'));
			},
		);
	});

	it('falls back to plain JSON search indexes when gzip is unavailable', async () => {
		await withTempSearchIndex(
			'search-index.finra.individual.json',
			JSON.stringify({ generatedAt: '2026-06-06T00:00:00.000Z', bucket: 'finra:individual', docs: [] }),
			async (root) => {
				const resolvedPath = getSearchIndexFilePath('finra:individual', [root]);
				expect(resolvedPath).toBe(path.join(root, 'data', 'national', 'search-index.finra.individual.json'));
			},
		);
	});

	describe('cleanSearchQuery', () => {
		it('extracts numeric CRD from Name :: CRD# [number] format', () => {
			expect(cleanSearchQuery('Jeremi C. Holmes :: CRD# 8137832')).toBe('8137832');
			expect(cleanSearchQuery('Jeremi C. Holmes :: CRD 8137832')).toBe('8137832');
			expect(cleanSearchQuery('Jeremi C. Holmes :: 8137832')).toBe('8137832');
			expect(cleanSearchQuery('Jeremi C. Holmes ::   CRD#   8137832')).toBe('8137832');
		});

		it('extracts numeric CRD from standalone CRD prefix format', () => {
			expect(cleanSearchQuery('CRD# 8137832')).toBe('8137832');
			expect(cleanSearchQuery('crd 8137832')).toBe('8137832');
			expect(cleanSearchQuery('CRD#8137832')).toBe('8137832');
		});

		it('leaves regular queries unchanged', () => {
			expect(cleanSearchQuery('Jeremi C. Holmes')).toBe('Jeremi C. Holmes');
			expect(cleanSearchQuery('8137832')).toBe('8137832');
			expect(cleanSearchQuery('Goldman Sachs')).toBe('Goldman Sachs');
		});
	});
});
