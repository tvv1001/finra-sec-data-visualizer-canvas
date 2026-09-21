import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "build_search_indexes.js");

// Direct imports of builder helpers
const {
	buildIndividualDoc,
	buildFirmDoc,
	buildOrphanDoc,
	buildDocFromDetail,
	unwrapDetail,
	mergeDocLists,
	decodeRedisValue,
	decompressBase64,
	getDetailRoot,
	matchesBucketFile,
	buildInventoryStubDoc,
} = require(scriptPath);

async function withTempRepo(run: (root: string) => void | Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "finra-build-search-indexes-"));
	await mkdir(path.join(root, "data", "national"), { recursive: true });
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("build_search_indexes script", () => {
	it("keeps missing local search indexes non-fatal when Redis fallback is configured", async () => {
		await withTempRepo(async (root) => {
			const result = spawnSync(process.execPath, [scriptPath], {
				cwd: root,
				env: {
					...process.env,
					UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
					UPSTASH_REDIS_REST_TOKEN: "test-token",
				},
				encoding: "utf8",
			});

			expect(result.status).toBe(0);
			expect(result.stderr).toContain("runtime search can fall back to Redis");
			expect(result.stderr).not.toContain("Missing finra:individual search index output");
		});
	});

	it("correctly builds individual doc with normalized employments and search text", () => {
		const detail = {
			basicInformation: {
				individualId: 12345,
				firstName: "John",
				middleName: "A",
				lastName: "Doe",
				otherNames: ["Johnny Doe"],
				bcScope: "Active",
			},
			currentEmployments: [
				{
					firmId: 9999,
					firmName: "Acme Corp",
					branchOfficeLocations: [{ city: "New York", state: "NY" }],
				},
			],
		};

		const doc = buildIndividualDoc("finra", detail);
		expect(doc).not.toBeNull();
		expect(doc.id).toBe("finra:individual:12345");
		expect(doc.hit.ind_firstname).toBe("John");
		expect(doc.hit.ind_lastname).toBe("Doe");
		expect(doc.hit.ind_connection_count).toBeGreaterThanOrEqual(1);
		expect(doc.nameSearchText).toContain("john");
		expect(doc.nameSearchText).toContain("johnny doe");
		expect(doc.addressSearchText).toContain("new york");
		expect(doc.searchText).toContain("12345");
		expect(doc.searchText).toContain("9999");
	});

	it("correctly builds firm doc with address details and name variants", () => {
		const detail = {
			basicInformation: {
				firmId: 8888,
				firmName: "Apex Financial LLC",
				otherNames: ["Apex Wealth"],
				bcScope: "Active",
			},
			firmAddressDetails: {
				officeAddress: {
					city: "Chicago",
					state: "IL",
					street1: "100 Main St",
				},
			},
		};

		const doc = buildFirmDoc("sec", detail);
		expect(doc).not.toBeNull();
		expect(doc.id).toBe("sec:firm:8888");
		expect(doc.hit.firm_name).toBe("Apex Financial LLC");
		expect(doc.nameSearchText).toContain("apex financial llc");
		expect(doc.addressSearchText).toContain("chicago");
		expect(doc.searchText).toContain("8888");
	});

	it("builds orphan stubs when full detail is absent", () => {
		const orphanDetail = {
			orphan: {
				crd: "55555",
				firmName: "Orphan Securities",
			},
		};

		const doc = buildDocFromDetail({ source: "finra", type: "firm" }, orphanDetail);
		expect(doc).not.toBeNull();
		expect(doc.id).toBe("finra:firm:55555");
		expect(doc.hit.firm_name).toBe("Orphan Securities");
		expect(doc.hit._orphanStub).toBe(true);
	});

	it("unwraps envelopes and decodes brotli-compressed strings", () => {
		const rawPayload = {
			basicInformation: {
				individualId: 77777,
				firstName: "Compressed",
				lastName: "User",
			},
		};
		const jsonString = JSON.stringify(rawPayload);
		const compressedB64 = "br:" + zlib.brotliCompressSync(Buffer.from(jsonString)).toString("base64");

		const decoded = decodeRedisValue(compressedB64);
		expect(decoded).toBe(jsonString);

		const parsed = JSON.parse(decoded);
		const doc = buildIndividualDoc("finra", parsed);
		expect(doc.id).toBe("finra:individual:77777");
		expect(doc.hit.ind_firstname).toBe("Compressed");
	});

	it("merges doc lists prioritizing richer docs over stubs without losing unique CRDs", () => {
		const stubDoc = {
			id: "finra:firm:1001",
			type: "firm",
			source: "finra",
			nameSearchText: "",
			strictSearchText: "1001",
			searchText: "1001",
			hit: { firm_id: "1001", firm_name: "", _orphanStub: true },
		};

		const fullDoc = {
			id: "finra:firm:1001",
			type: "firm",
			source: "finra",
			nameSearchText: "rich securities inc",
			strictSearchText: "1001 rich securities inc new york ny",
			searchText: "1001 rich securities inc",
			hit: { firm_id: "1001", firm_name: "Rich Securities Inc", _orphanStub: false },
		};

		const otherDoc = {
			id: "finra:firm:2002",
			type: "firm",
			source: "finra",
			nameSearchText: "other firm",
			strictSearchText: "2002 other firm",
			searchText: "2002 other firm",
			hit: { firm_id: "2002", firm_name: "Other Firm", _orphanStub: false },
		};

		// Merging stub first, then full doc, plus other doc
		const merged = mergeDocLists([stubDoc], [fullDoc, otherDoc]);
		expect(merged).toHaveLength(2);

		const firm1001 = merged.find((d) => d.id === "finra:firm:1001");
		expect(firm1001.hit.firm_name).toBe("Rich Securities Inc");
		expect(firm1001.hit._orphanStub).toBe(false);

		const firm2002 = merged.find((d) => d.id === "finra:firm:2002");
		expect(firm2002.hit.firm_name).toBe("Other Firm");
	});

	it("matches file names across national and raw directory structures", () => {
		const bucketFinraInd = { source: "finra", type: "individual", filePattern: /^(?:api\.brokercheck\.finra\.org_search_individual_|finra[:_-]individual[:_-]|brokercheck[:_-]individual[:_-])\d+\.json$/i };
		expect(matchesBucketFile(bucketFinraInd, "api.brokercheck.finra.org_search_individual_1080419.json")).toBe(true);
		expect(matchesBucketFile(bucketFinraInd, "finra:individual:1080419.json")).toBe(true);
		expect(matchesBucketFile(bucketFinraInd, "finra-individual-1080419.json")).toBe(true);
		expect(matchesBucketFile(bucketFinraInd, "1080419.json", "data/national/brokercheck/individual")).toBe(true);
		expect(matchesBucketFile(bucketFinraInd, "1080419.json", "data/raw/brokercheck/individual")).toBe(true);
		expect(matchesBucketFile(bucketFinraInd, "summaryHtml_1080419.json")).toBe(false);
	});

	it("emits named inventory stubs for crd-log CRDs without raw or Redis detail, but lets full detail win", async () => {
		await withTempRepo(async (root) => {
			const natDir = path.join(root, "data", "national");
			const rawDir = path.join(root, "data", "raw", "brokercheck.finra.org");
			await mkdir(rawDir, { recursive: true });

			// CRD inventory: one individual and one firm with no detail anywhere, plus one
			// individual (33333) that also has a full raw detail file.
			await writeFile(
				path.join(root, "data", "crd-log.json"),
				JSON.stringify({
					firms: [
						{ id: 4444, name: "Inventory Only Securities LLC" },
						{ id: 0, name: "Invalid Firm" },
					],
					individuals: [
						{ id: 33333, name: "Stale InventoryName" },
						{ id: 44444, name: "Inventory Only Person" },
						{ id: 55555, name: "" },
					],
				}),
				"utf8",
			);

			await writeFile(
				path.join(rawDir, "api.brokercheck.finra.org_search_individual_33333.json"),
				JSON.stringify({
					basicInformation: { individualId: 33333, firstName: "Real", lastName: "Detail" },
					currentEmployments: [{ firmId: 4444, firmName: "Inventory Only Securities LLC" }],
				}),
				"utf8",
			);

			const result = spawnSync(process.execPath, [scriptPath], {
				cwd: root,
				env: { ...process.env, USE_LOCAL_REDIS: "0" },
				encoding: "utf8",
			});
			expect(result.status).toBe(0);

			const readBucket = async (bucket: string) => {
				const jsonPath = path.join(natDir, `search-index.finra.${bucket}.json`);
				const fromJson = JSON.parse(await readFile(jsonPath, "utf8"));
				const fromGz = JSON.parse(zlib.gunzipSync(await readFile(`${jsonPath}.gz`)).toString("utf8"));
				return { fromJson, fromGz };
			};

			const individuals = await readBucket("individual");
			const firms = await readBucket("firm");

			for (const { docs } of [individuals.fromJson, individuals.fromGz]) {
				const inventoryOnly = docs.find((d: any) => d.id === "finra:individual:44444");
				expect(inventoryOnly).toBeTruthy();
				expect(inventoryOnly.hit.ind_firstname).toBe("Inventory");
				expect(inventoryOnly.hit.ind_lastname).toBe("Person");
				expect(inventoryOnly.hit._inventoryStub).toBe(true);
				expect(inventoryOnly.nameSearchText).toContain("inventory only person");

				// Full raw detail must win over the inventory stub for the same CRD.
				const withDetail = docs.find((d: any) => d.id === "finra:individual:33333");
				expect(withDetail.hit.ind_firstname).toBe("Real");
				expect(withDetail.hit._inventoryStub).toBeUndefined();

				// Entries without a valid id or name are not indexed.
				expect(docs.some((d: any) => d.id === "finra:individual:55555")).toBe(false);
			}

			for (const { docs } of [firms.fromJson, firms.fromGz]) {
				const firmStub = docs.find((d: any) => d.id === "finra:firm:4444");
				expect(firmStub).toBeTruthy();
				expect(firmStub.hit.firm_name).toBe("Inventory Only Securities LLC");
				expect(firmStub.hit._inventoryStub).toBe(true);
				expect(docs.some((d: any) => d.id === "finra:firm:0")).toBe(false);
			}

			// SEC buckets stay inventory-free.
			const secIndividual = path.join(natDir, "search-index.sec.individual.json");
			await expect(readFile(secIndividual, "utf8")).rejects.toThrow();
		});
	});

	it("ranks a full detail doc above an inventory stub for the same CRD", () => {
		const stub = buildInventoryStubDoc({ name: "finra:firm", source: "finra", type: "firm" }, { id: 6006, name: "Inventory Firm" });
		const full = {
			id: "finra:firm:6006",
			type: "firm",
			source: "finra",
			nameSearchText: "real firm inc",
			addressSearchText: "",
			strictSearchText: "6006 real firm inc",
			searchText: "6006 real firm inc",
			hit: { firm_id: "6006", firm_name: "Real Firm Inc" },
		};

		expect(mergeDocLists([stub], [full])[0].hit.firm_name).toBe("Real Firm Inc");
		expect(mergeDocLists([full], [stub])[0].hit.firm_name).toBe("Real Firm Inc");
	});

	it("preserves previously indexed records and merges new raw files during CLI run", async () => {
		await withTempRepo(async (root) => {
			const natDir = path.join(root, "data", "national");
			const rawDir = path.join(root, "data", "raw", "brokercheck.finra.org");
			await mkdir(rawDir, { recursive: true });

			// 1. Create pre-existing search-index file with CRD 11111
			const existingDoc = {
				id: "finra:individual:11111",
				type: "individual",
				source: "finra",
				nameSearchText: "existing person",
				addressSearchText: "",
				strictSearchText: "11111 existing person",
				searchText: "11111 existing person",
				hit: { ind_source_id: "11111", ind_crd: "11111", ind_firstname: "Existing", ind_lastname: "Person" },
			};
			const existingIndex = {
				generatedAt: "2026-08-01T00:00:00.000Z",
				bucket: "finra:individual",
				docs: [existingDoc],
			};
			const jsonOut = path.join(natDir, "search-index.finra.individual.json");
			await writeFile(jsonOut, JSON.stringify(existingIndex), "utf8");
			await writeFile(`${jsonOut}.gz`, zlib.gzipSync(Buffer.from(JSON.stringify(existingIndex))));

			// 2. Add new raw file with CRD 22222 in data/raw/
			const newRawDetail = {
				hits: {
					total: 1,
					hits: [
						{
							_type: "_doc",
							_source: {
								content: JSON.stringify({
									basicInformation: {
										individualId: 22222,
										firstName: "New",
										lastName: "RawUser",
									},
								}),
							},
						},
					],
				},
			};
			await writeFile(
				path.join(rawDir, "api.brokercheck.finra.org_search_individual_22222.json"),
				JSON.stringify(newRawDetail),
				"utf8",
			);

			// 3. Execute script
			const result = spawnSync(process.execPath, [scriptPath], {
				cwd: root,
				env: {
					...process.env,
					USE_LOCAL_REDIS: "0",
				},
				encoding: "utf8",
			});

			expect(result.status).toBe(0);

			// 4. Verify output contains BOTH CRD 11111 (preserved) and CRD 22222 (merged from raw)
			const updatedJson = JSON.parse(await readFile(jsonOut, "utf8"));
			const ids = updatedJson.docs.map((d: any) => d.id);
			expect(ids).toContain("finra:individual:11111");
			expect(ids).toContain("finra:individual:22222");

			// 5. Verify .gz exists and contains both
			const gzBuf = await readFile(`${jsonOut}.gz`);
			const uncompressed = JSON.parse(zlib.gunzipSync(gzBuf).toString("utf8"));
			const gzIds = uncompressed.docs.map((d: any) => d.id);
			expect(gzIds).toContain("finra:individual:11111");
			expect(gzIds).toContain("finra:individual:22222");
		});
	});
});
