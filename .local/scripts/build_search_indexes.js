#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = process.cwd();
const NATIONAL_DIR = path.join(ROOT, "data", "national");
const RAW_DIR = path.join(ROOT, "data", "raw");
const CRD_LOG_PATH = path.join(ROOT, "data", "crd-log.json");
const FINRA_DIR = path.join(NATIONAL_DIR, "brokercheck.finra.org");
const SEC_DIR = path.join(NATIONAL_DIR, "adviserinfo.sec.gov");
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const BUCKETS = [
	{
		name: "finra:individual",
		source: "finra",
		type: "individual",
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_individual_|finra[:_-]individual[:_-]|brokercheck[:_-]individual[:_-])\d+\.json$/i,
		redisPrefix: "finra:individual:",
	},
	{
		name: "finra:firm",
		source: "finra",
		type: "firm",
		dir: FINRA_DIR,
		filePattern: /^(?:api\.brokercheck\.finra\.org_search_firm_|finra[:_-]firm[:_-]|brokercheck[:_-]firm[:_-])\d+\.json$/i,
		redisPrefix: "finra:firm:",
	},
	{
		name: "sec:individual",
		source: "sec",
		type: "individual",
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_individual_|sec[:_-]individual[:_-]|adviserinfo[:_-]individual[:_-])\d+\.json$/i,
		redisPrefix: "sec:individual:",
	},
	{
		name: "sec:firm",
		source: "sec",
		type: "firm",
		dir: SEC_DIR,
		filePattern: /^(?:api\.adviserinfo\.sec\.gov_search_firm_|sec[:_-]firm[:_-]|adviserinfo[:_-]firm[:_-])\d+\.json$/i,
		redisPrefix: "sec:firm:",
	},
];

function isValidUpstashUrl(value) {
	return typeof value === "string" && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes("...");
}

function canFallbackToRedis() {
	return Boolean(REDIS_TOKEN) && isValidUpstashUrl(REDIS_URL);
}

// `next build` loads .env.local, but this script runs as a plain node process before it, so
// flags like USE_LOCAL_REDIS (which selects the local Redis detail cache as a sidecar source)
// were never visible here. Read them directly, without overriding real env vars.
function loadLocalEnvFlags() {
	const FLAGS = ["USE_LOCAL_REDIS", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
	try {
		const raw = require("node:fs").readFileSync(path.join(ROOT, ".env.local"), "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
			if (!match) continue;
			const [, key, rawValue] = match;
			if (!FLAGS.includes(key) || process.env[key] != null) continue;
			process.env[key] = rawValue.replace(/^[\"']|[\"']$/g, "");
		}
	} catch {
		/* no .env.local (CI/Vercel) — rely on the real environment */
	}
}

function toText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function uniqueTexts(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const text = toText(value);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
}

function collectScalarTexts(value, out = [], seen = new WeakSet()) {
	if (value == null) return out;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectScalarTexts(entry, out, seen);
		return out;
	}
	if (typeof value === "object") {
		if (seen.has(value)) return out;
		seen.add(value);
		for (const entry of Object.values(value)) collectScalarTexts(entry, out, seen);
	}
	return out;
}

function ensureArray(value) {
	return Array.isArray(value) ? value : [];
}

function normalizeBranchLocation(location) {
	if (!location || typeof location !== "object") return null;
	const normalized = {
		city: toText(location.city) || null,
		state: toText(location.state) || null,
		street1: toText(location.street1) || null,
		street2: toText(location.street2) || null,
		zipCode: toText(location.zipCode) || null,
	};
	return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeEmployment(employment) {
	if (!employment || typeof employment !== "object") return null;
	const firmId = toText(employment.firmId ?? employment.firm_id ?? employment.firmIdNumber);
	const firmName = toText(employment.firmName ?? employment.firm_name);
	const branchOfficeLocations = ensureArray(employment.branchOfficeLocations).map(normalizeBranchLocation).filter(Boolean);
	const branchLocation = branchOfficeLocations[0] || null;
	return {
		firmId: firmId ? Number(firmId) || firmId : null,
		firm_id: firmId ? Number(firmId) || firmId : null,
		firmName: firmName || null,
		firm_name: firmName || null,
		iaOnly: employment.iaOnly ?? null,
		registrationBeginDate: employment.registrationBeginDate ?? null,
		registrationEndDate: employment.registrationEndDate ?? null,
		employmentStatus: employment.employmentStatus ?? null,
		firmBCScope: employment.firmBCScope ?? employment.firm_bc_scope ?? null,
		firmIAScope: employment.firmIAScope ?? employment.firm_ia_scope ?? null,
		bdSECNumber: toText(employment.bdSECNumber ?? employment.bdSecNumber ?? employment.firm_bd_sec_number) || null,
		iaSECNumber: toText(employment.iaSECNumber ?? employment.iaSecNumber ?? employment.firm_ia_sec_number) || null,
		city: toText(employment.city ?? branchLocation?.city) || null,
		state: toText(employment.state ?? branchLocation?.state) || null,
		zipCode: toText(employment.zipCode ?? branchLocation?.zipCode) || null,
		expelledDate: employment.expelledDate ?? null,
		branchOfficeLocations,
	};
}

function normalizeEmployments(employments) {
	return ensureArray(employments).map(normalizeEmployment).filter(Boolean);
}

function getCurrentEmploymentFirmNames(detail) {
	return uniqueTexts([
		...normalizeEmployments(detail.currentEmployments).map((employment) => employment.firmName),
		...normalizeEmployments(detail.currentIAEmployments).map((employment) => employment.firmName),
		...ensureArray(detail.previousEmployments).map((employment) => employment?.firmName ?? employment?.firm_name),
		...ensureArray(detail.previousIAEmployments).map((employment) => employment?.firmName ?? employment?.firm_name),
	]);
}

function getRegistrationCount(detail) {
	const registrations = detail?.registrations && typeof detail.registrations === "object" ? detail.registrations : {};
	return {
		approvedFinraRegistrationCount: registrations.approvedFinraRegistrationCount ?? 0,
		approvedSRORegistrationCount: registrations.approvedSRORegistrationCount ?? 0,
		approvedStateRegistrationCount: registrations.approvedStateRegistrationCount ?? 0,
		approvedIAStateRegistrationCount: registrations.approvedIAStateRegistrationCount ?? 0,
	};
}

function buildIndividualDoc(source, detail, fallbackId) {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === "object" ? detail.basicInformation : {};
	const individualId = toText(
		basicInformation.individualId ??
		basicInformation.crdNumber ??
		basicInformation.crd ??
		detail?.individualId ??
		detail?.ind_crd ??
		detail?.ind_source_id ??
		detail?.crd ??
		detail?.crdNumber ??
		fallbackId
	);
	if (!individualId) return null;

	const firstName = toText(basicInformation.firstName ?? detail?.firstName ?? detail?.ind_firstname ?? detail?.first_name);
	const middleName = toText(basicInformation.middleName ?? detail?.middleName ?? detail?.ind_middlename ?? detail?.middle_name);
	const lastName = toText(basicInformation.lastName ?? detail?.lastName ?? detail?.ind_lastname ?? detail?.last_name);
	const otherNames = uniqueTexts([
		...ensureArray(basicInformation.otherNames),
		...ensureArray(detail?.otherNames),
		...ensureArray(detail?.ind_other_names),
	]);

	const currentEmployments = normalizeEmployments(detail?.currentEmployments ?? detail?.ind_current_employments);
	const currentIAEmployments = normalizeEmployments(detail?.currentIAEmployments ?? detail?.ind_ia_current_employments);
	const previousEmployments = normalizeEmployments(detail?.previousEmployments ?? detail?.ind_previous_employments);
	const previousIAEmployments = normalizeEmployments(detail?.previousIAEmployments ?? detail?.ind_ia_previous_employments);
	const firmIds = uniqueTexts([
		...currentEmployments.map((e) => e.firmId),
		...currentIAEmployments.map((e) => e.firmId),
		...previousEmployments.map((e) => e.firmId),
		...previousIAEmployments.map((e) => e.firmId),
	]);
	const registrationCount = getRegistrationCount(detail);

	const currentAddressTexts = uniqueTexts([
		...currentEmployments.flatMap((e) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
		...currentIAEmployments.flatMap((e) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
	]);

	const nameTexts = uniqueTexts([firstName, middleName, lastName, ...otherNames]);
	const hit = {
		ind_source_id: individualId,
		ind_crd: individualId,
		ind_firstname: firstName,
		ind_middlename: middleName,
		ind_lastname: lastName,
		ind_other_names: otherNames,
		otherNames,
		ind_bc_scope: toText(basicInformation.bcScope ?? detail?.bcScope ?? detail?.ind_bc_scope),
		ind_ia_scope: toText(basicInformation.iaScope ?? detail?.iaScope ?? detail?.ind_ia_scope),
		ind_approved_finra_registration_count: registrationCount.approvedFinraRegistrationCount,
		ind_approved_sro_registration_count: registrationCount.approvedSRORegistrationCount,
		ind_approved_state_registration_count: registrationCount.approvedStateRegistrationCount,
		ind_approved_ia_state_registration_count: registrationCount.approvedIAStateRegistrationCount,
		ind_current_employments: currentEmployments,
		ind_ia_current_employments: currentIAEmployments,
		ind_previous_employments: previousEmployments,
		ind_ia_previous_employments: previousIAEmployments,
		disclosureFlag: detail?.bdDisclosureFlag ?? detail?.disclosureFlag ?? null,
		iaDisclosureFlag: detail?.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:individual:${individualId}`,
		type: "individual",
		source,
		nameSearchText: nameTexts.join(" ").toLowerCase(),
		addressSearchText: currentAddressTexts.join(" ").toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(" ").toLowerCase(),
		searchText: uniqueTexts([individualId, ...nameTexts, ...firmIds])
			.join(" ")
			.toLowerCase(),
		hit,
	};
}

function buildFirmDoc(source, detail, fallbackId) {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === "object" ? detail.basicInformation : {};
	const firmId = toText(
		basicInformation.firmId ??
		basicInformation.crdNumber ??
		basicInformation.crd ??
		detail?.firmId ??
		detail?.firm_id ??
		detail?.firm_source_id ??
		detail?.crd ??
		detail?.crdNumber ??
		fallbackId
	);
	if (!firmId) return null;

	const firmName = toText(
		basicInformation.firmName ??
		basicInformation.businessName ??
		basicInformation.legalName ??
		detail?.firmName ??
		detail?.firm_name ??
		detail?.businessName ??
		detail?.legalName ??
		detail?.name
	);
	const otherNames = uniqueTexts([
		...ensureArray(basicInformation.otherNames),
		...ensureArray(detail?.otherNames),
		...ensureArray(detail?.firm_other_names),
	]);

	const addressDetails = detail?.firmAddressDetails || detail?.addressDetails || {};
	const office = addressDetails.officeAddress || addressDetails.office || addressDetails.mainAddress || {};
	const mailing = addressDetails.mailingAddress || addressDetails.mailing || {};
	const currentAddressTexts = uniqueTexts([office.city, office.state, office.street1, office.street2, mailing.city, mailing.state, mailing.street1, mailing.street2]);

	const nameTexts = uniqueTexts([firmName, ...otherNames]);
	const hit = {
		firm_id: firmId,
		firmId,
		firm_source_id: firmId,
		firm_name: firmName,
		firmName,
		firm_other_names: otherNames,
		otherNames,
		firm_bc_scope: toText(basicInformation.bcScope ?? detail?.bcScope ?? detail?.firm_bc_scope),
		bdSecNumber: toText(basicInformation.bdSECNumber ?? detail?.bdSecNumber ?? detail?.bdSECNumber) || null,
		iaSecNumber: toText(basicInformation.iaSECNumber ?? detail?.iaSecNumber ?? detail?.iaSECNumber) || null,
		disclosureFlag: detail?.bdDisclosureFlag ?? detail?.disclosureFlag ?? null,
		iaDisclosureFlag: detail?.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:firm:${firmId}`,
		type: "firm",
		source,
		nameSearchText: nameTexts.join(" ").toLowerCase(),
		addressSearchText: currentAddressTexts.join(" ").toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(" ").toLowerCase(),
		searchText: uniqueTexts([firmId, ...nameTexts])
			.join(" ")
			.toLowerCase(),
		hit,
	};
}

// Detail payloads arrive wrapped in a few different envelopes depending on which upstream
// endpoint/cache wrote them. Unwrap them all so every cached CRD produces a sidecar doc
// instead of being silently dropped.
const DETAIL_WRAPPER_KEYS = ["finraBrokerCheck", "secInvestmentAdvisor", "secInvestmentAdviser"];

// Some cached payloads store the real detail as a JSON-serialized Node Buffer
// (`{ type: "Buffer", data: [...] }`) whose bytes are themselves an encoded detail string.
function reviveBufferJson(value) {
	if (!value || typeof value !== "object" || value.type !== "Buffer" || !Array.isArray(value.data)) return null;
	try {
		return JSON.parse(decodeRedisValue(Buffer.from(value.data).toString("utf-8")));
	} catch {
		return null;
	}
}

function unwrapDetail(detail) {
	let current = detail;
	for (let depth = 0; depth < 6; depth += 1) {
		if (!current || typeof current !== "object") return current;
		const revived = reviveBufferJson(current);
		if (revived) {
			current = revived;
			continue;
		}
		const wrapperKey = DETAIL_WRAPPER_KEYS.find((key) => current[key] && typeof current[key] === "object");
		if (!wrapperKey) return current;
		const wrapped = reviveBufferJson(current[wrapperKey]) ?? current[wrapperKey];
		current = { ...current, ...wrapped };
		delete current[wrapperKey];
	}
	return current;
}

// A negative cache entry ("we asked upstream and there is no such record") must not be
// turned into an empty sidecar doc.
function isNegativeCacheDetail(detail) {
	if (!detail || typeof detail !== "object") return false;
	if (detail.hits && typeof detail.hits === "object") {
		const total = detail.hits.total;
		const totalVal = typeof total === "number" ? total : total && total.value;
		if (totalVal === 0 && Array.isArray(detail.hits.hits) && detail.hits.hits.length === 0) {
			return !detail.basicInformation && !detail.orphan && !detail.firmName && !detail.firstName;
		}
	}
	return false;
}

// Some cached records only exist as "orphan" stubs discovered via a parent firm/person
// (no full BrokerCheck/AdviserInfo detail payload). They still carry a real CRD and often a
// real name, so they belong in the sidecar — that name/CRD pair is exactly what graph and
// dashboard label hydration look up.
function buildOrphanDoc(bucket, detail, fallbackId) {
	const orphan = detail && typeof detail === "object" ? (detail.orphan || detail) : null;
	if (!orphan || typeof orphan !== "object") return null;
	const id = toText(orphan.crd ?? orphan.individualId ?? orphan.firmId ?? detail.crd ?? detail.crdNumber ?? fallbackId);
	if (!id) return null;

	const address = orphan.officeAddress && typeof orphan.officeAddress === "object" ? orphan.officeAddress : {};
	const addressTexts = uniqueTexts([address.street1, address.street2, address.city, address.state, address.country, address.postalCode]);

	if (bucket.type === "individual") {
		const nameTexts = uniqueTexts([orphan.name, orphan.fullName, orphan.legalName, orphan.firstName, orphan.lastName]);
		const rawName = toText(orphan.name ?? orphan.fullName ?? orphan.legalName ?? `${orphan.firstName || ""} ${orphan.lastName || ""}`.trim());
		const parts = rawName.split(" ").filter(Boolean);
		const hit = {
			ind_source_id: id,
			ind_crd: id,
			ind_firstname: parts.length > 1 ? parts[0] : (toText(orphan.firstName) || rawName),
			ind_middlename: parts.length > 2 ? parts.slice(1, -1).join(" ") : toText(orphan.middleName),
			ind_lastname: parts.length > 1 ? parts[parts.length - 1] : toText(orphan.lastName),
			ind_other_names: [],
			otherNames: [],
			ind_current_employments: [],
			ind_ia_current_employments: [],
			ind_previous_employments: [],
			ind_ia_previous_employments: [],
			_orphanStub: true,
		};
		return {
			id: `${bucket.source}:individual:${id}`,
			type: "individual",
			source: bucket.source,
			nameSearchText: nameTexts.join(" ").toLowerCase(),
			addressSearchText: addressTexts.join(" ").toLowerCase(),
			strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(" ").toLowerCase(),
			searchText: uniqueTexts([id, ...nameTexts]).join(" ").toLowerCase(),
			hit,
		};
	}

	const firmName = toText(orphan.firmName ?? orphan.name ?? orphan.businessName ?? orphan.legalName);
	const nameTexts = uniqueTexts([firmName]);
	const hit = {
		firm_id: id,
		firmId: id,
		firm_source_id: id,
		firm_name: firmName,
		firmName,
		firm_other_names: [],
		otherNames: [],
		_orphanStub: true,
	};
	return {
		id: `${bucket.source}:firm:${id}`,
		type: "firm",
		source: bucket.source,
		nameSearchText: nameTexts.join(" ").toLowerCase(),
		addressSearchText: addressTexts.join(" ").toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(" ").toLowerCase(),
		searchText: uniqueTexts([id, ...nameTexts]).join(" ").toLowerCase(),
		hit,
	};
}

// Every CRD the app has ever inventoried lives in `data/crd-log.json` with its display name.
// Some of those CRDs have no raw file and no local Redis detail yet, so without this the
// sidecar could not resolve their names at all. Emit a minimal named stub for them; any real
// detail doc for the same CRD outranks it in `mergeDocLists`.
function buildInventoryStubDoc(bucket, entry) {
	const id = toText(entry && typeof entry === "object" ? entry.id : entry);
	const name = toText(entry && typeof entry === "object" ? entry.name : "");
	if (!/^\d+$/.test(id) || Number(id) <= 0 || !name) return null;

	const seed = bucket.type === "individual" ? { crd: id, name } : { crd: id, firmName: name };
	const doc = buildOrphanDoc(bucket, { orphan: seed }, id);
	if (!doc) return null;

	const hit = { ...doc.hit, _inventoryStub: true };
	delete hit._orphanStub;
	return { ...doc, hit };
}

// The CRD inventory is FINRA-keyed (dashboard/graph label hydration reads the FINRA buckets),
// so inventory stubs are only emitted into `finra:individual` / `finra:firm`.
async function readCrdLogInventoryDocs(bucket) {
	if (bucket.source !== "finra") return { docs: [], reason: `inventory stubs are FINRA-only (skipped ${bucket.name})` };

	let parsed;
	try {
		parsed = JSON.parse(await fs.readFile(CRD_LOG_PATH, "utf8"));
	} catch (error) {
		return { docs: [], reason: `no usable CRD inventory at ${CRD_LOG_PATH}: ${error?.message || error}` };
	}

	const entries = ensureArray(bucket.type === "individual" ? parsed?.individuals : parsed?.firms);
	const docs = [];
	for (const entry of entries) {
		const doc = buildInventoryStubDoc(bucket, entry);
		if (doc) docs.push(doc);
	}
	return { docs, reason: docs.length ? null : `no valid named CRD entries for ${bucket.name}` };
}

/** Build a sidecar doc from any supported cached payload shape. */
function buildDocFromDetail(bucket, rawDetail, fallbackId) {
	let detail = unwrapDetail(rawDetail);
	if (!detail || typeof detail !== "object") return null;
	if (isNegativeCacheDetail(detail)) return null;

	// If this is already a full sidecar doc structure (e.g. from existing sidecar file)
	if (detail.id && detail.hit && (detail.type === bucket.type || detail.source === bucket.source)) {
		return detail;
	}

	// Unwrapping can expose a nested search envelope (e.g. a Buffer-encoded payload whose bytes
	// are a full `hits.hits[0]._source.content` response), so re-extract the detail root.
	if (detail.hits && !detail.basicInformation) {
		const nested = unwrapDetail(getDetailRoot(bucket, detail));
		if (nested && typeof nested === "object") detail = nested;
	}
	const doc = bucket.type === "individual" ? buildIndividualDoc(bucket.source, detail, fallbackId) : buildFirmDoc(bucket.source, detail, fallbackId);
	return doc || buildOrphanDoc(bucket, detail, fallbackId);
}

/** True when a doc carries a usable display name (not just a CRD). */
function docHasName(doc) {
	return Boolean(toText(doc?.nameSearchText || doc?.hit?.firm_name || doc?.hit?.ind_firstname || doc?.hit?.firmName));
}

// Ranking tiers, highest first: a full detail doc (raw file / Redis / existing sidecar) always
// beats an orphan stub, which always beats a CRD-inventory stub synthesized from
// `data/crd-log.json`. Names and payload richness only break ties inside a tier.
function getDocScore(doc) {
	const hit = doc?.hit || {};
	let score = hit._inventoryStub ? 500 : hit._orphanStub ? 1000 : 2000;
	if (docHasName(doc)) score += 200;
	const strictLen = toText(doc?.strictSearchText).length;
	score += Math.min(strictLen, 400);
	return score;
}

// Merge doc lists into one per-id set. Sidecar consumers index by CRD first-wins
// (`getHitByIdMap` in src/lib/localSearch.ts), so a richer/named doc must always beat a
// bare stub for the same CRD.
function mergeDocLists(...docLists) {
	const byId = new Map();
	for (const docs of docLists) {
		for (const doc of docs || []) {
			if (!doc?.id) continue;
			const existing = byId.get(doc.id);
			if (!existing) {
				byId.set(doc.id, doc);
				continue;
			}
			const existingScore = getDocScore(existing);
			const newScore = getDocScore(doc);
			if (newScore > existingScore) {
				byId.set(doc.id, doc);
			}
		}
	}
	return [...byId.values()];
}

function parseMaybeJson(value) {
	if (value && typeof value === "object") return value;
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

// Cached source files nest the real payload under `hits.hits[0]._source.content` (FINRA) /
// `.iacontent` (SEC), and that field is often a JSON *string*.
function getDetailRoot(bucket, payload) {
	if (!payload || typeof payload !== "object") return null;
	const roots = [
		payload,
		payload?.hits?.hits?.[0]?._source,
		payload?.hits?.hits?.[0],
		payload?._source,
		payload?.result,
		payload?.data,
	];
	const fieldNames = bucket.source === "finra" ? ["content", "iacontent", "body", "detail"] : ["iacontent", "content", "body", "detail"];
	for (const root of roots) {
		if (!root || typeof root !== "object") continue;
		for (const field of fieldNames) {
			const detail = parseMaybeJson(root[field]);
			if (detail) return detail;
		}
	}
	return null;
}

async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

// Cached values come in three flavours: plain JSON, the app's `br:` + base64 brotli envelope
// (src/lib/redisCache.ts), and bare base64 brotli/gzip written by older importers.
function decompressBase64(raw) {
	if (typeof raw !== "string" || raw.length < 8 || /[^A-Za-z0-9+/=\r\n]/.test(raw)) return null;
	let buffer;
	try {
		buffer = Buffer.from(raw, "base64");
	} catch {
		return null;
	}
	if (!buffer.length) return null;
	for (const decompress of [zlib.brotliDecompressSync, zlib.gunzipSync, zlib.inflateSync]) {
		try {
			return decompress(buffer).toString("utf-8");
		} catch {
			/* try the next codec */
		}
	}
	return null;
}

function decodeRedisValue(raw) {
	if (typeof raw !== "string") return raw;
	let current = raw;
	for (let pass = 0; pass < 4; pass += 1) {
		const trimmed = current.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) return current;
		const candidate = trimmed.startsWith("br:") ? trimmed.slice(3) : trimmed;
		const decoded = decompressBase64(candidate);
		if (decoded == null) return current;
		current = decoded;
	}
	return current;
}

function getBucketDirectories(bucket) {
	const dirs = [];
	// Primary national directory
	dirs.push(bucket.dir);

	// Raw source directory (e.g. data/raw/brokercheck.finra.org or data/raw/adviserinfo.sec.gov)
	const rawSourceDir = path.join(RAW_DIR, bucket.source === "finra" ? "brokercheck.finra.org" : "adviserinfo.sec.gov");
	dirs.push(rawSourceDir);

	// Direct subdirectories by type (e.g. data/national/brokercheck/individual, data/raw/brokercheck/individual)
	const nationalTypeDir = path.join(NATIONAL_DIR, bucket.source === "finra" ? "brokercheck" : "adviserinfo", bucket.type);
	dirs.push(nationalTypeDir);

	const rawTypeDir = path.join(RAW_DIR, bucket.source === "finra" ? "brokercheck" : "adviserinfo", bucket.type);
	dirs.push(rawTypeDir);

	// External raw directory if passed in environment
	if (process.env.EXTERNAL_RAW_DIR) {
		dirs.push(path.join(process.env.EXTERNAL_RAW_DIR, bucket.source === "finra" ? "brokercheck.finra.org" : "adviserinfo.sec.gov"));
		dirs.push(path.join(process.env.EXTERNAL_RAW_DIR, bucket.source === "finra" ? "brokercheck" : "adviserinfo", bucket.type));
		dirs.push(process.env.EXTERNAL_RAW_DIR);
	}

	return [...new Set(dirs)];
}

function matchesBucketFile(bucket, fileName, dirPath = "") {
	if (typeof fileName !== "string" || !fileName.endsWith(".json")) return false;
	// Skip non-detail files
	if (
		fileName.includes("summaryHtml") ||
		fileName.startsWith("search-index") ||
		fileName.includes("manifest") ||
		fileName.includes("report") ||
		fileName.includes("crd-log")
	) {
		return false;
	}

	// Direct regex match
	if (bucket.filePattern && bucket.filePattern.test(fileName)) {
		return true;
	}

	// If numeric filename <CRD>.json, check whether directory context matches bucket
	if (/^\d+\.json$/.test(fileName)) {
		const normalizedDir = (dirPath || "").replace(/\\/g, "/").toLowerCase();
		if (normalizedDir.endsWith(`/${bucket.type}`) || normalizedDir.includes(`/${bucket.type}/`)) {
			if (bucket.source === "finra" && (normalizedDir.includes("brokercheck") || normalizedDir.includes("finra"))) {
				return true;
			}
			if (bucket.source === "sec" && (normalizedDir.includes("adviserinfo") || normalizedDir.includes("sec"))) {
				return true;
			}
		}
	}

	return false;
}

// Rebuild the search-index sidecar from the same detail records the local Redis cache holds
// (finra:individual:<crd>, finra:firm:<crd>, sec:individual:<crd>, sec:firm:<crd>) so the
// dashboard/graph search sidecar carries real address/employment data instead of label-only
// stubs.
async function readBucketDocsFromLocalRedis(bucket) {
	let IORedis;
	try {
		IORedis = require("ioredis");
	} catch {
		return { docs: null, generatedAt: null, reason: "ioredis module not available" };
	}

	const redis = new IORedis("redis://127.0.0.1:6379", { lazyConnect: true, maxRetriesPerRequest: 1 });
	try {
		await redis.connect();
	} catch (error) {
		return { docs: null, generatedAt: null, reason: `local Redis unavailable: ${error?.message || error}` };
	}

	try {
		const detailKeyPattern = new RegExp(`^${bucket.redisPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`);
		const keys = (await redis.keys(`${bucket.redisPrefix}*`)).filter((key) => detailKeyPattern.test(key));
		if (!keys.length) return { docs: null, generatedAt: null, reason: `no keys found for ${bucket.redisPrefix}*` };

		const docs = [];
		const BATCH_SIZE = 500;
		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batchKeys = keys.slice(i, i + BATCH_SIZE);
			const values = await redis.mget(batchKeys);
			for (let j = 0; j < values.length; j += 1) {
				const rawValue = values[j];
				if (!rawValue) continue;
				const fallbackId = batchKeys[j].slice(bucket.redisPrefix.length);
				try {
					const decoded = decodeRedisValue(rawValue);
					const payload = JSON.parse(decoded);
					const source = payload?.hits?.hits?.[0]?._source || payload?.hits?.hits?.[0] || payload?._source || payload;
					let detail = null;

					const detailField = bucket.source === "finra" ? (source?.content ?? source?.iacontent) : (source?.iacontent ?? source?.content);
					if (typeof detailField === "string") {
						try {
							detail = JSON.parse(detailField);
						} catch {}
					} else if (detailField && typeof detailField === "object") {
						detail = detailField;
					} else {
						detail = source;
					}

					const doc = buildDocFromDetail(bucket, detail, fallbackId);
					if (doc) docs.push(doc);
				} catch {
					// skip malformed cache entries
				}
			}
		}

		return { docs, generatedAt: new Date().toISOString(), reason: null };
	} finally {
		redis.disconnect();
	}
}

async function readExistingSidecarDocs(bucket) {
	const jsonPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
	const gzPath = `${jsonPath}.gz`;
	const publicGzPath = path.join(ROOT, "public", "search-indexes", `search-index.${bucket.source}.${bucket.type}.json.gz`);

	// Try reading uncompressed JSON first
	if (await fileExists(jsonPath)) {
		try {
			const raw = await fs.readFile(jsonPath, "utf8");
			const data = JSON.parse(raw);
			if (Array.isArray(data?.docs) && data.docs.length) {
				return { docs: data.docs, generatedAt: data.generatedAt || null, source: jsonPath };
			}
		} catch (e) {
			console.warn(`Failed reading existing sidecar JSON from ${jsonPath}:`, e.message);
		}
	}

	// Try reading gzipped national sidecar
	if (await fileExists(gzPath)) {
		try {
			const gzBuf = await fs.readFile(gzPath);
			const uncompressed = zlib.gunzipSync(gzBuf).toString("utf8");
			const data = JSON.parse(uncompressed);
			if (Array.isArray(data?.docs) && data.docs.length) {
				return { docs: data.docs, generatedAt: data.generatedAt || null, source: gzPath };
			}
		} catch (e) {
			console.warn(`Failed reading existing sidecar GZ from ${gzPath}:`, e.message);
		}
	}

	// Try reading public gzipped sidecar as fallback
	if (await fileExists(publicGzPath)) {
		try {
			const gzBuf = await fs.readFile(publicGzPath);
			const uncompressed = zlib.gunzipSync(gzBuf).toString("utf8");
			const data = JSON.parse(uncompressed);
			if (Array.isArray(data?.docs) && data.docs.length) {
				return { docs: data.docs, generatedAt: data.generatedAt || null, source: publicGzPath };
			}
		} catch (e) {
			console.warn(`Failed reading existing public sidecar GZ from ${publicGzPath}:`, e.message);
		}
	}

	return { docs: [], generatedAt: null, source: null };
}

async function readBucketDocs(bucket) {
	const dirs = getBucketDirectories(bucket);
	const docs = [];
	let generatedAt = null;
	const seenFiles = new Set();
	let scannedDirCount = 0;

	for (const dir of dirs) {
		let fileNames = [];
		try {
			fileNames = (await fs.readdir(dir)).filter((fileName) => matchesBucketFile(bucket, fileName, dir)).sort();
		} catch {
			continue;
		}

		if (!fileNames.length) continue;
		scannedDirCount += 1;

		for (const fileName of fileNames) {
			const filePath = path.join(dir, fileName);
			if (seenFiles.has(filePath)) continue;
			seenFiles.add(filePath);

			try {
				const content = await fs.readFile(filePath, "utf8");
				const payload = JSON.parse(content);
				const detail = getDetailRoot(bucket, payload) || payload;
				const fallbackId = (fileName.match(/(\d+)\.json$/) || [])[1] || "";
				const doc = buildDocFromDetail(bucket, detail, fallbackId);
				if (!doc) continue;
				docs.push(doc);

				for (const value of [payload.generatedAt, payload.generated, detail.generatedAt, detail.generated]) {
					const text = toText(value);
					if (text && (!generatedAt || text > generatedAt)) generatedAt = text;
				}
			} catch (error) {
				console.warn(`Skipping malformed search-index source ${filePath}:`, error?.message || error);
			}
		}
	}

	if (!docs.length && scannedDirCount === 0) {
		return { docs: null, generatedAt: null, reason: `no source directories found for ${bucket.name}` };
	}
	if (!docs.length) {
		return { docs: null, generatedAt: null, reason: `no valid source files matched for ${bucket.name}` };
	}

	return { docs, generatedAt, reason: null };
}

async function writeBucket(bucket, docs, generatedAt) {
	const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(
		outputPath,
		JSON.stringify(
			{
				generatedAt: generatedAt || new Date().toISOString(),
				bucket: bucket.name,
				docs,
			},
			null,
			2,
		),
		"utf8",
	);
	const gzPath = `${outputPath}.gz`;
	const gzBuffer = zlib.gzipSync(await fs.readFile(outputPath), { level: 9 });
	await fs.writeFile(gzPath, gzBuffer);
	return outputPath;
}

async function gzipExistingBucket(outputPath) {
	const gzPath = `${outputPath}.gz`;
	const raw = await fs.readFile(outputPath);
	const gzBuffer = zlib.gzipSync(raw, { level: 9 });
	await fs.writeFile(gzPath, gzBuffer);
	return gzPath;
}

async function main() {
	loadLocalEnvFlags();
	let skippedBuckets = 0;
	const useLocalRedis = process.env.USE_LOCAL_REDIS === "1";

	for (const bucket of BUCKETS) {
		const outputPath = path.join(NATIONAL_DIR, `search-index.${bucket.source}.${bucket.type}.json`);
		const gzPath = `${outputPath}.gz`;

		// 1. Read existing sidecar docs to ensure lossless preservation
		const existingResult = await readExistingSidecarDocs(bucket);
		const existingDocs = Array.isArray(existingResult.docs) ? existingResult.docs : [];

		// 2. Read disk files from data/national and data/raw
		const fileResult = await readBucketDocs(bucket);
		const fileDocs = Array.isArray(fileResult.docs) ? fileResult.docs : [];
		let generatedAt = fileResult.generatedAt || existingResult.generatedAt || null;
		let reason = fileResult.reason;

		// 3. Read local Redis if configured
		let redisDocs = [];
		if (useLocalRedis) {
			const redisResult = await readBucketDocsFromLocalRedis(bucket);
			if (Array.isArray(redisResult.docs) && redisResult.docs.length) {
				redisDocs = redisResult.docs;
				generatedAt = redisResult.generatedAt || generatedAt;
				reason = null;
			} else if (redisResult.reason) {
				console.log(`Local Redis fallback skipped for ${bucket.name}: ${redisResult.reason}`);
			}
		}

		// 4. Read the CRD inventory log so every app-known named CRD is discoverable
		const inventoryResult = await readCrdLogInventoryDocs(bucket);
		const inventoryDocs = Array.isArray(inventoryResult.docs) ? inventoryResult.docs : [];
		if (!inventoryDocs.length && inventoryResult.reason) {
			console.log(`CRD inventory stubs skipped for ${bucket.name}: ${inventoryResult.reason}`);
		}

		// 5. Merge all available doc sources
		const docListsToMerge = [];
		if (inventoryDocs.length) docListsToMerge.push(inventoryDocs);
		if (existingDocs.length) docListsToMerge.push(existingDocs);
		if (fileDocs.length) docListsToMerge.push(fileDocs);
		if (redisDocs.length) docListsToMerge.push(redisDocs);

		if (docListsToMerge.length > 0) {
			const merged = mergeDocLists(...docListsToMerge);
			if (merged.length > 0) {
				const named = merged.filter(docHasName).length;
				await writeBucket(bucket, merged, generatedAt);
				const parts = [];
				if (inventoryDocs.length) parts.push(`inventory: ${inventoryDocs.length}`);
				if (existingDocs.length) parts.push(`existing: ${existingDocs.length}`);
				if (fileDocs.length) parts.push(`files: ${fileDocs.length}`);
				if (redisDocs.length) parts.push(`redis: ${redisDocs.length}`);
				console.log(
					`Built ${bucket.name} search index with ${merged.length} docs (${named} with labels) and gzipped sidecar. (${parts.join(", ")})`,
				);
				continue;
			}
		}

		// 6. Fallback preservation if only existing output path exists
		if (await fileExists(outputPath)) {
			await gzipExistingBucket(outputPath);
			console.log(`Preserved ${bucket.name} search index and refreshed gzipped sidecar because ${reason || "no docs were generated"}.`);
			continue;
		}

		if (await fileExists(gzPath)) {
			console.log(`Preserved ${bucket.name} gzipped search index because ${reason || "no docs were generated"}; raw source is not available in this build environment.`);
			continue;
		}

		skippedBuckets += 1;
		const reasonText = reason || "no docs were generated";
		if (canFallbackToRedis()) {
			console.warn(`Skipping ${bucket.name} local search index output because ${reasonText}; runtime search can fall back to Redis.`);
			continue;
		}

		console.warn(`Skipping ${bucket.name} local search index output because ${reasonText}; runtime search will rely on available local or remote data sources.`);
	}

	if (skippedBuckets > 0) {
		console.log(`Search index build completed with ${skippedBuckets} skipped bucket(s) because source data was unavailable in this environment.`);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("build_search_indexes failed:", error);
		process.exit(1);
	});
}

module.exports = {
	buildIndividualDoc,
	buildFirmDoc,
	buildOrphanDoc,
	buildInventoryStubDoc,
	buildDocFromDetail,
	unwrapDetail,
	mergeDocLists,
	collectScalarTexts,
	uniqueTexts,
	decodeRedisValue,
	decompressBase64,
	getDetailRoot,
	readCrdLogInventoryDocs,
	readExistingSidecarDocs,
	readBucketDocs,
	readBucketDocsFromLocalRedis,
	matchesBucketFile,
	getBucketDirectories,
	main,
};
