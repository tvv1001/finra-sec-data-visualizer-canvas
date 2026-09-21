#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { Redis } = require('@upstash/redis');
const axios = require('axios');

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'data', 'national');
const FINRA = path.join(BASE, 'brokercheck.finra.org');
const SEC = path.join(BASE, 'adviserinfo.sec.gov');
const GRAPH_FILE = path.join(BASE, 'finra-graph.json');
const SEED_BANK_FILE = path.join(BASE, 'finra-seed-bank.json');
const REDIS_GRAPH_KEY = 'graph:snapshot';
const REDIS_SEED_BANK_KEY = 'graph:seed-bank';

function personId(crd) {
	return `person:${crd}`;
}
function firmId(id) {
	return `firm:${id}`;
}

let redisClient;
function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}
function getRedis() {
	if (redisClient !== undefined) return redisClient;
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		redisClient = null;
		return redisClient;
	}
	if (!isValidUpstashUrl(url)) {
		throw new Error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(url)}. ` + 'It must be a real Upstash HTTPS URL like https://<id>.upstash.io');
	}
	if (typeof token !== 'string' || !token.trim() || token.includes('...')) {
		throw new Error('Invalid UPSTASH_REDIS_REST_TOKEN: token is missing or appears to be a placeholder.');
	}
	redisClient = new Redis({ url, token });
	return redisClient;
}

function resolveId(ref) {
	if (ref && typeof ref === 'object') return ref.id ?? null;
	return ref ?? null;
}

function ensureArray(value) {
	return Array.isArray(value) ? value : [];
}

function toText(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

function uniqueTexts(values) {
	const out = [];
	const seen = new Set();
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

function uniqueSortedIds(values) {
	return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function firstMeaningfulText(...values) {
	for (const value of values) {
		const text = String(value || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) return text;
	}
	return '';
}

function normalizeSeedName(value) {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	if (
		/^\d+$/.test(text) ||
		/^\d+-\d+$/.test(text) ||
		/^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(text) ||
		/^8-\d+$/i.test(text) ||
		/^person\s+\d+$/i.test(text) ||
		/^firm\s+\d+$/i.test(text)
	) {
		return '';
	}
	return text;
}

function getSeedNodeDisplayName(node) {
	const basic = node?.basicInformation || {};
	if (node?.group === 'individual') {
		const fullName = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ');
		return normalizeSeedName(firstMeaningfulText(fullName, basic.name, node?.name, node?.personName, node?.displayName, node?.legalName, node?.label));
	}
	if (node?.group === 'firm') {
		return normalizeSeedName(
			firstMeaningfulText(
				basic.firmName,
				basic.name,
				node?.firmName,
				node?.organizationName,
				node?.organization_name,
				node?.companyName,
				node?.name,
				node?.displayName,
				node?.legalName,
				node?.label,
			),
		);
	}
	return '';
}

const STATE_NAME_TO_CODE = {
	alabama: 'AL',
	alaska: 'AK',
	arizona: 'AZ',
	arkansas: 'AR',
	california: 'CA',
	colorado: 'CO',
	connecticut: 'CT',
	delaware: 'DE',
	'district of columbia': 'DC',
	florida: 'FL',
	georgia: 'GA',
	hawaii: 'HI',
	idaho: 'ID',
	illinois: 'IL',
	indiana: 'IN',
	iowa: 'IA',
	kansas: 'KS',
	kentucky: 'KY',
	louisiana: 'LA',
	maine: 'ME',
	maryland: 'MD',
	massachusetts: 'MA',
	michigan: 'MI',
	minnesota: 'MN',
	mississippi: 'MS',
	missouri: 'MO',
	montana: 'MT',
	nebraska: 'NE',
	nevada: 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	ohio: 'OH',
	oklahoma: 'OK',
	oregon: 'OR',
	pennsylvania: 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	tennessee: 'TN',
	texas: 'TX',
	utah: 'UT',
	vermont: 'VT',
	virginia: 'VA',
	washington: 'WA',
	'west virginia': 'WV',
	wisconsin: 'WI',
	wyoming: 'WY',
	'puerto rico': 'PR',
	'virgin islands': 'VI',
	guam: 'GU',
	'american samoa': 'AS',
	'northern mariana islands': 'MP',
};

const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

function normalizeStateCode(value) {
	const text = String(value || '')
		.replace(/\./g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	const upper = text.toUpperCase();
	if (STATE_CODES.has(upper)) return upper;
	return STATE_NAME_TO_CODE[text.toLowerCase()] || '';
}

function extractStateFromAddress(address) {
	if (!address) return '';
	if (typeof address === 'object') {
		return normalizeStateCode(address.state || address.stateCode || address.province || address.region);
	}
	const text = String(address).trim();
	if (!text) return '';
	const direct = normalizeStateCode(text);
	if (direct) return direct;
	const match = text.match(/\b([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?$/);
	if (match) return normalizeStateCode(match[1]);
	return '';
}

function pickRegisteredState(records) {
	if (!Array.isArray(records) || records.length === 0) return '';
	for (const record of records) {
		const normalized = normalizeStateCode(record?.state || record?.stateCode || record?.jurisdiction);
		const status = String(record?.status || record?.regStatus || '')
			.trim()
			.toLowerCase();
		if (normalized && /(approved|active|current)/.test(status)) return normalized;
	}
	for (const record of records) {
		const normalized = normalizeStateCode(record?.state || record?.stateCode || record?.jurisdiction);
		if (normalized) return normalized;
	}
	return '';
}

function parseEmbeddedJson(value) {
	if (!value || typeof value !== 'string') return value;
	try {
		const parsed = JSON.parse(value);
		return parsed;
	} catch {
		return value;
	}
}

function getDetailPayload(record) {
	if (!record || typeof record !== 'object') return null;
	const raw = record.content ?? record.iacontent ?? null;
	return parseEmbeddedJson(raw);
}

function getLocationHintsFromDetail(detail, group) {
	if (!detail || typeof detail !== 'object') return {};
	const basic = detail.basicInformation || {};
	const district = firstMeaningfulText(basic.districtName, basic.district, basic.regionName);

	if (group === 'individual') {
		const currentEmployments = [...(detail.currentEmployments || []), ...(detail.currentIAEmployments || [])];
		for (const employment of currentEmployments) {
			const office = employment?.branchOfficeLocations?.[0] || {};
			const state = normalizeStateCode(employment?.state || office?.state || office?.stateCode);
			if (state) {
				return {
					locationState: state,
					locationDistrict: firstMeaningfulText(office?.city, district),
					locationBiasSource: 'current_office',
				};
			}
		}

		const registeredState = pickRegisteredState(detail.registeredStates);
		if (registeredState) {
			return {
				locationState: registeredState,
				locationDistrict: district,
				locationBiasSource: 'registered_state',
			};
		}

		const basicState = normalizeStateCode(basic.state || basic.stateCode || basic.homeState || basic.residenceState);
		if (basicState) {
			return {
				locationState: basicState,
				locationDistrict: district,
				locationBiasSource: 'basic_state',
			};
		}

		if (district) {
			return { locationDistrict: district, locationBiasSource: 'district' };
		}
		return {};
	}

	const officeState = extractStateFromAddress(detail.officeAddress) || extractStateFromAddress(detail.mailingAddress);
	if (officeState) {
		return {
			locationState: officeState,
			locationDistrict: district,
			locationBiasSource: 'office_address',
		};
	}

	const registrationState =
		pickRegisteredState(detail.registrations?.stateList) ||
		pickRegisteredState(detail.registrationStatus) ||
		pickRegisteredState(detail.noticeFilings);
	if (registrationState) {
		return {
			locationState: registrationState,
			locationDistrict: district,
			locationBiasSource: 'registered_state',
		};
	}

	const formedState = normalizeStateCode(basic.formedState);
	if (formedState) {
		return {
			locationState: formedState,
			locationDistrict: district,
			locationBiasSource: 'formed_state',
		};
	}

	if (district) {
		return { locationDistrict: district, locationBiasSource: 'district' };
	}
	return {};
}

function buildIndividualNode(crd, detail, fallbackLabel = '') {
	const basic = detail?.basicInformation || {};
	const fullName = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ').trim();

	const currentEmployments = ensureArray(detail.currentEmployments);
	const currentIAEmployments = ensureArray(detail.currentIAEmployments);
	const currentAddressTexts = uniqueTexts([
		...currentEmployments.flatMap((e) => [e.city, e.state, ...ensureArray(e.branchOfficeLocations).flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
		...currentIAEmployments.flatMap((e) => [e.city, e.state, ...ensureArray(e.branchOfficeLocations).flatMap((l) => [l.street1, l.street2, l.city, l.state])]),
	]);

	return {
		id: personId(crd),
		label: fullName || fallbackLabel || String(crd),
		group: 'individual',
		...(currentAddressTexts.length ? { addressSearchText: currentAddressTexts.join(' ').toLowerCase() } : {}),
		...(basic && Object.keys(basic).length ? { basicInformation: basic } : {}),
		...getLocationHintsFromDetail(detail, 'individual'),
	};
}

function buildFirmNode(id, detail, fallbackLabel = '') {
	const basic = detail?.basicInformation || {};

	const addressDetails = detail.firmAddressDetails || {};
	const office = addressDetails.officeAddress || {};
	const mailing = addressDetails.mailingAddress || {};
	const currentAddressTexts = uniqueTexts([office.city, office.state, office.street1, office.street2, mailing.city, mailing.state, mailing.street1, mailing.street2]);

	return {
		id: firmId(id),
		label: basic.firmName || fallbackLabel || String(id),
		group: 'firm',
		...(currentAddressTexts.length ? { addressSearchText: currentAddressTexts.join(' ').toLowerCase() } : {}),
		...(basic && Object.keys(basic).length ? { basicInformation: basic } : {}),
		...getLocationHintsFromDetail(detail, 'firm'),
	};
}

function getNumericSeedNumber(nodeId, group) {
	const prefix = group === 'individual' ? 'person:' : 'firm:';
	if (!String(nodeId || '').startsWith(prefix)) return '';
	const rawNumber = String(nodeId || '')
		.slice(prefix.length)
		.trim();
	return /^\d+$/.test(rawNumber) ? rawNumber : '';
}

function buildSeedBankFromGraph(graph) {
	const individuals = [];
	const firms = [];
	const entities = [];
	const others = [];
	const allNodeIds = [];
	const nameByNumber = { individual: {}, firm: {} };

	for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
		const nodeId = resolveId(node);
		if (!nodeId) continue;
		allNodeIds.push(nodeId);
		switch (node?.group) {
			case 'individual':
				individuals.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'individual');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.individual[rawNumber] = displayName;
				}
				break;
			case 'firm':
				firms.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'firm');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.firm[rawNumber] = displayName;
				}
				break;
			case 'entity':
				entities.push(nodeId);
				break;
			default:
				others.push(nodeId);
				break;
		}
	}

	const individualIds = uniqueSortedIds(individuals);
	const firmIds = uniqueSortedIds(firms);
	const entityIds = uniqueSortedIds(entities);
	const otherIds = uniqueSortedIds(others);
	const uniqueAllNodeIds = uniqueSortedIds(allNodeIds);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds: uniqueAllNodeIds,
		nameByNumber,
		updatedAt: new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: uniqueAllNodeIds.length,
		},
	};
}

async function saveGraphArtifacts(graph, { syncRedis = true } = {}) {
	const seedBank = buildSeedBankFromGraph(graph);
	await fs.mkdir(path.dirname(GRAPH_FILE), { recursive: true });
	await fs.writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf-8');
	await fs.writeFile(SEED_BANK_FILE, JSON.stringify(seedBank, null, 2), 'utf-8');

	if (!syncRedis) return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: false };

	const redis = getRedis();
	if (!redis) return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: false };

	console.log('Uploading graph and seed bank to Redis...');
	await redis.set(REDIS_GRAPH_KEY, JSON.stringify(graph));
	await redis.set(REDIS_SEED_BANK_KEY, JSON.stringify(seedBank));

	// Precompute and store neighborhoods for the top 100 nodes with most connections
	try {
		console.log('Precomputing neighborhoods for high-degree nodes...');
		const connectionCounts = new Map();
		for (const link of graph.links || []) {
			const s = link.source?.id ?? link.source;
			const t = link.target?.id ?? link.target;
			if (s) connectionCounts.set(s, (connectionCounts.get(s) || 0) + 1);
			if (t) connectionCounts.set(t, (connectionCounts.get(t) || 0) + 1);
		}

		const sortedNodes = [...(graph.nodes || [])]
			.map((node) => ({ id: node.id, degree: connectionCounts.get(node.id) || 0 }))
			.sort((a, b) => b.degree - a.degree)
			.slice(0, 100);

		const adjacency = new Map();
		for (const link of graph.links || []) {
			const s = link.source?.id ?? link.source;
			const t = link.target?.id ?? link.target;
			if (!adjacency.has(s)) adjacency.set(s, new Set());
			if (!adjacency.has(t)) adjacency.set(t, new Set());
			adjacency.get(s).add(t);
			adjacency.get(t).add(s);
		}

		const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

		for (const { id, degree } of sortedNodes) {
			if (degree < 5) continue; // Don't bother with small neighborhoods
			const neighbors = Array.from(adjacency.get(id) || []);
			const neighborhoodIds = new Set([id, ...neighbors]);
			const resultNodes = graph.nodes.filter((n) => neighborhoodIds.has(n.id));
			const resultLinks = graph.links.filter((l) => {
				const s = l.source?.id ?? l.source;
				const t = l.target?.id ?? l.target;
				return neighborhoodIds.has(s) && neighborhoodIds.has(t);
			});

			await redis.set(`finra:expand:${id}:1`, JSON.stringify({ nodes: resultNodes, links: resultLinks }));
		}
		console.log(`Stored ${sortedNodes.length} neighborhood clusters in Redis.`);
	} catch (e) {
		console.warn('Failed to precompute neighborhoods:', e.message);
	}

	return { graphFile: GRAPH_FILE, seedBankFile: SEED_BANK_FILE, redisSynced: true };
}

async function ensureGraphArtifacts(options = {}) {
	try {
		await fs.access(GRAPH_FILE);
		return { existed: true, built: false };
	} catch {
		console.log('finra-graph.json missing; rebuilding from cached source files.');
		await build(options);
		return { existed: false, built: true };
	}
}

function normalizeEmploymentScope(rawValue) {
	const value = String(rawValue || 'current')
		.trim()
		.toLowerCase();
	if (['current', 'previous', 'all', 'none'].includes(value)) return value;
	throw new Error(`Invalid employment scope "${rawValue}". Use current, previous, all, or none.`);
}

function getEmploymentScopeOptions(scope) {
	return {
		scope,
		includeCurrent: scope === 'current' || scope === 'all',
		includePrevious: scope === 'previous' || scope === 'all',
		enableHeuristicEmploymentLinks: scope === 'all',
	};
}

function collectEmploymentRecords(source, options) {
	if (!source || typeof source !== 'object' || options.scope === 'none') return [];
	const records = [];
	if (options.includeCurrent) {
		records.push(...(source.ind_current_employments || source.currentEmployments || []));
	}
	if (options.includePrevious) {
		records.push(...(source.ind_previous_employments || source.previousEmployments || []));
	}
	return records;
}

async function readJsonFiles(dir) {
	const out = [];
	try {
		const files = await fs.readdir(dir);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw = await fs.readFile(path.join(dir, f), 'utf-8');
				out.push({ file: f, json: JSON.parse(raw) });
			} catch {}
		}
	} catch {}
	return out;
}

function extractPeopleAndFirmsFromHits(json, employmentOptions) {
	const nodes = { people: new Map(), firms: new Map(), links: [] };
	const hits = json?.hits?.hits || [];
	for (const h of hits) {
		const src = h._source || {};
		const detail = getDetailPayload(src);
		const parsedDetail = detail && typeof detail === 'string' ? parseEmbeddedJson(detail) : detail;
		const crd =
			src.ind_source_id ||
			src.person?.crd ||
			(parsedDetail &&
				(() => {
					try {
						const p = parsedDetail;
						return p?.basicInformation?.crd || p?.basicInformation?.individualId || p?.individualId || p?.crd;
					} catch {
						return null;
					}
				})());
		if (crd) {
			nodes.people.set(
				String(crd),
				detail ?
					buildIndividualNode(crd, detail, `${src.ind_firstname || ''} ${src.ind_lastname || ''}`.trim())
				:	{ id: personId(crd), label: `${src.ind_firstname || ''} ${src.ind_lastname || ''}`.trim() || String(crd), group: 'individual' },
			);
			const emps = detail ? collectEmploymentRecords(detail, employmentOptions) : collectEmploymentRecords(src, employmentOptions);
			for (const e of emps) {
				const fid = e.firmId || e.firm_id || e.firmId;
				if (fid) {
					nodes.firms.set(String(fid), { ...(nodes.firms.get(String(fid)) || {}), id: firmId(fid), label: e.firmName || String(fid), group: 'firm' });
					nodes.links.push({
						source: personId(crd),
						target: firmId(fid),
						relationship: e._isCurrent === false ? 'previous_employed_by' : 'employed_by',
						isCurrent: e._isCurrent,
					});
				}
			}
		}
		// firms in source
		const sourceFirmId =
			src.firm_id ||
			src.firm_bd_sec_number ||
			src.firm_bd_full_sec_number ||
			detail?.basicInformation?.firmId ||
			detail?.basicInformation?.bdSECNumber;
		if (sourceFirmId) {
			const fid = sourceFirmId;
			nodes.firms.set(
				String(fid),
				detail ?
					buildFirmNode(fid, detail, src.firm_name || src.firmName || String(fid))
				:	{ id: firmId(fid), label: src.firm_name || src.firmName || String(fid), group: 'firm' },
			);
		}
	}

	const detail = getDetailPayload(json);
	const parsedDetail = detail && typeof detail === 'string' ? parseEmbeddedJson(detail) : detail;
	if (parsedDetail?.basicInformation) {
		const basic = parsedDetail.basicInformation || {};
		const crd = basic.crd || basic.individualId || parsedDetail.individualId || parsedDetail.crd;
		if (crd) {
			nodes.people.set(String(crd), { ...(nodes.people.get(String(crd)) || {}), ...buildIndividualNode(crd, detail) });
			const emps = collectEmploymentRecords(detail, employmentOptions);
			for (const e of emps) {
				const fid = e.firmId || e.firm_id || e.firmId;
				if (!fid) continue;
				nodes.firms.set(String(fid), { ...(nodes.firms.get(String(fid)) || {}), id: firmId(fid), label: e.firmName || String(fid), group: 'firm' });
				nodes.links.push({
					source: personId(crd),
					target: firmId(fid),
					relationship: e._isCurrent === false ? 'previous_employed_by' : 'employed_by',
					isCurrent: e._isCurrent,
				});
			}
		}

		const fid = basic.firmId || basic.bdSECNumber;
		if (fid) {
			nodes.firms.set(String(fid), { ...(nodes.firms.get(String(fid)) || {}), ...buildFirmNode(fid, detail) });
		}
	}
	return nodes;
}

function normalizeLink(link) {
	if (!link || typeof link !== 'object') return link;
	const sourceId = String(link.source?.id ?? link.source ?? '');
	const targetId = String(link.target?.id ?? link.target ?? '');
	const inferredRelationship =
		sourceId.startsWith('person:') && targetId.startsWith('firm:') ? 'employed_by'
		: (sourceId.startsWith('firm:') || sourceId.startsWith('entity:')) && targetId.startsWith('firm:') ? 'controls'
		: '';
	const relationship = link.relationship || link.type || inferredRelationship || '';
	const normalized = relationship ? { ...link, relationship } : { ...link };
	if ('type' in normalized) delete normalized.type;
	if (normalized.relationship === 'previous_employed_by' && normalized.isCurrent === undefined) {
		normalized.isCurrent = false;
	}
	return normalized;
}

async function build(options = {}) {
	const employmentOptions = options.employmentOptions || getEmploymentScopeOptions('current');
	const syncRedis = options.syncRedis !== false;
	let existingGraph = { nodes: [], links: [], meta: {} };
	try {
		existingGraph = JSON.parse(await fs.readFile(GRAPH_FILE, 'utf-8'));
	} catch {
		existingGraph = { nodes: [], links: [], meta: {} };
	}
	existingGraph = {
		...(existingGraph || {}),
		nodes: Array.isArray(existingGraph?.nodes) ? existingGraph.nodes : [],
		links: Array.isArray(existingGraph?.links) ? existingGraph.links.map((link) => normalizeLink(link)) : [],
		meta: existingGraph?.meta && typeof existingGraph.meta === 'object' ? existingGraph.meta : {},
	};

	const people = new Map();
	const firms = new Map();
	const links = [];

	console.log(`build_graph_from_cache: employment scope=${employmentOptions.scope}`);

	async function processDirectory(dir) {
		try {
			const files = await fs.readdir(dir);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				try {
					const raw = await fs.readFile(path.join(dir, f), 'utf-8');
					const json = JSON.parse(raw);
					const { people: p, firms: fo, links: li } = extractPeopleAndFirmsFromHits(json, employmentOptions);
					for (const [k, v] of p) people.set(k, v);
					for (const [k, v] of fo) firms.set(k, v);
					for (const l of li) links.push(l);
				} catch (e) {
					// Skip errors
				}
			}
		} catch (e) {
			// Skip dir errors
		}
	}

	await processDirectory(FINRA);
	await processDirectory(SEC);
	if (process.env.EXTERNAL_RAW_DIR) {
		await processDirectory(process.env.EXTERNAL_RAW_DIR);
	}

	if (people.size === 0 && firms.size === 0) {
		try {
			const existing = existingGraph;
			if ((Array.isArray(existing?.nodes) && existing.nodes.length) || (Array.isArray(existing?.links) && existing.links.length)) {
				console.log('No cached host JSON files found; preserving existing graph artifact.');
				const saved = await saveGraphArtifacts(existing, { syncRedis });
				console.log('Saved graph artifacts:', saved);
				return existing;
			}
		} catch {
			// fall through to empty graph generation
		}
	}

	const firmIdSet = new Set(Array.from(firms.keys()));

	// Helper: recursively search an object for firm ids
	function findFirmIds(obj, out = new Set()) {
		if (!obj) return out;
		if (typeof obj === 'string' || typeof obj === 'number') {
			const s = String(obj).trim();
			if (firmIdSet.has(s)) out.add(s);
			return out;
		}
		if (Array.isArray(obj)) {
			for (const v of obj) findFirmIds(v, out);
			return out;
		}
		if (typeof obj === 'object') {
			for (const v of Object.values(obj)) findFirmIds(v, out);
			return out;
		}
		return out;
	}

	// Heuristic: find firm names in object fields
	function findFirmNames(obj, out = new Set()) {
		if (!obj) return out;
		if (typeof obj === 'string') {
			const s = obj.trim();
			if (s.length > 2 && /firm|broker|bd|broker-dealer|company/i.test(s) && s.length < 120) out.add(s);
			return out;
		}
		if (typeof obj === 'number') return out;
		if (Array.isArray(obj)) {
			for (const v of obj) findFirmNames(v, out);
			return out;
		}
		if (typeof obj === 'object') {
			for (const [k, v] of Object.entries(obj)) {
				if (/firm|firmName|firm_name|broker/i.test(k)) findFirmNames(v, out);
				else findFirmNames(v, out);
			}
			return out;
		}
		return out;
	}

	// Second pass: for each file, if it corresponds to a person, look for firm ids in its content
	async function secondPass(dir) {
		try {
			const files = await fs.readdir(dir);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				try {
					const raw = await fs.readFile(path.join(dir, f), 'utf-8');
					const obj = JSON.parse(raw);
					// try to find a crd for person
					let crd = null;
					try {
						// Try to extract CRD from the hits
						const hits = obj?.hits?.hits || [];
						for (const hit of hits) {
							const src = hit._source || {};
							if (src.ind_source_id) crd = String(src.ind_source_id);
							else if (src.person && src.person.crd) crd = String(src.person.crd);
							else if (src.content) {
								const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
								crd = c?.basicInformation?.crd || c?.basicInformation?.individualId;
								if (crd) crd = String(crd);
							}
							if (crd) break; // Found one, stop looking
						}
					} catch (e) {
						crd = null;
					}
					if (crd && people.has(crd)) {
						if (employmentOptions.enableHeuristicEmploymentLinks) {
							const found = findFirmIds(obj);
							for (const fid of found) {
								links.push({ source: personId(crd), target: firmId(fid), relationship: 'employed_by' });
								firms.set(fid, firms.get(fid) || { id: firmId(fid), label: String(fid), group: 'firm' });
							}
							// Heuristic firm names
							const names = findFirmNames(obj);
							for (const nm of names) {
								const slug = nm
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, '_')
									.replace(/^_|_$/g, '');
								const fid = `name:${slug}`;
								links.push({ source: personId(crd), target: firmId(fid), relationship: 'employed_by' });
								firms.set(fid, firms.get(fid) || { id: firmId(fid), label: nm, group: 'firm' });
							}
						}
						// also try parsing content JSON more deeply for employment arrays
						try {
							const hits = obj?.hits?.hits || [];
							for (const hit of hits) {
								const src = hit._source || {};
								let c = null;
								if (src.content) {
									c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
								}
								if (c) {
									const selectedEmps = collectEmploymentRecords(c, employmentOptions);
									for (const e of selectedEmps) {
										const fid = e.firmId || e.firm_id || e.firmId;
										if (fid) {
											links.push({ source: personId(crd), target: firmId(String(fid)), relationship: 'employed_by' });
											firms.set(String(fid), firms.get(String(fid)) || { id: firmId(String(fid)), label: e.firmName || String(fid), group: 'firm' });
										}
									}
								}
							}
						} catch (e) {}
					}

					// Inspect firm files for directOwners → create 'controls' links
					let targetFirm = null;
					try {
						targetFirm =
							obj.firm_id ||
							obj.firmId ||
							obj.firm_bd_sec_number ||
							obj.bdSECNumber ||
							(obj.content &&
								(() => {
									try {
										const c = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content;
										return c?.basicInformation?.firmId || c?.basicInformation?.bdSECNumber;
									} catch {
										return null;
									}
								})());
						if (targetFirm) targetFirm = String(targetFirm);
					} catch (e) {
						targetFirm = null;
					}
					if (targetFirm) {
						try {
							const owners = obj.directOwners || [];
							if (Array.isArray(owners) && owners.length) {
								for (const o of owners) {
									if (o.ownerFirmId) {
										const ofid = String(o.ownerFirmId);
										firms.set(ofid, firms.get(ofid) || { id: firmId(ofid), label: String(ofid), group: 'firm' });
										links.push({ source: firmId(ofid), target: firmId(targetFirm), relationship: 'controls' });
									} else if (o.ownerId || o.ownerPersonId || o.crdNumber || o.crd) {
										const pid = String(o.ownerId || o.ownerPersonId || o.crdNumber || o.crd);
										people.set(pid, people.get(pid) || { id: personId(pid), label: String(pid), group: 'individual' });
										links.push({ source: personId(pid), target: firmId(targetFirm), relationship: 'controls' });
									} else if (o.ownerName) {
										const slug = String(o.ownerName)
											.toLowerCase()
											.replace(/[^a-z0-9]+/g, '_')
											.replace(/^_|_$/g, '');
										const eid = `entity:${slug}`;
										firms.set(eid, firms.get(eid) || { id: firmId(eid), label: o.ownerName, group: 'entity' });
										links.push({ source: firmId(eid), target: firmId(targetFirm), relationship: 'controls' });
									}
								}
							}
						} catch (e) {}
					}
				} catch (e) {}
			}
		} catch (e) {}
	}

	await secondPass(FINRA);
	await secondPass(SEC);
	if (process.env.EXTERNAL_RAW_DIR) {
		await secondPass(process.env.EXTERNAL_RAW_DIR);
	}
	// Fallback: if no links discovered, attach first person to a synthetic firm so graph isn't empty
	if (links.length === 0 && people.size > 0) {
		const firstPerson = people.keys().next().value;
		const fid = 'name:unknown_employer';
		firms.set(fid, firms.get(fid) || { id: firmId(fid), label: 'Unknown Employer', group: 'firm' });
		links.push({ source: personId(firstPerson), target: firmId(fid), relationship: 'employed_by' });
	}

	const nodes = [...people.values(), ...firms.values()];
	const dedupedLinks = [];
	const seenLinks = new Set();
	for (const link of links) {
		const source = link.source?.id ?? link.source;
		const target = link.target?.id ?? link.target;
		const type = link.type || link.relationship || '';
		const key = `${source}|${target}|${type}`;
		if (seenLinks.has(key)) continue;
		seenLinks.add(key);
		dedupedLinks.push(normalizeLink(link));
	}

	const mergedNodeMap = new Map();
	for (const node of Array.isArray(existingGraph?.nodes) ? existingGraph.nodes : []) {
		if (!node?.id) continue;
		mergedNodeMap.set(node.id, node);
	}
	for (const node of nodes) {
		if (!node?.id) continue;
		mergedNodeMap.set(node.id, { ...(mergedNodeMap.get(node.id) || {}), ...node });
	}

	const mergedLinks = [];
	const mergedLinkKeys = new Set();
	for (const link of [...(Array.isArray(existingGraph?.links) ? existingGraph.links : []), ...dedupedLinks]) {
		const source = link.source?.id ?? link.source;
		const target = link.target?.id ?? link.target;
		const type = link.type || link.relationship || '';
		const key = `${source}|${target}|${type}`;
		if (mergedLinkKeys.has(key)) continue;
		mergedLinkKeys.add(key);
		mergedLinks.push(normalizeLink(link));
	}

	const mergedNodes = [...mergedNodeMap.values()];
	const graph = {
		nodes: mergedNodes,
		links: mergedLinks,
		meta: {
			generated: new Date().toISOString(),
			totalIndividuals: mergedNodes.filter((node) => node.group === 'individual').length,
			totalFirms: mergedNodes.filter((node) => node.group === 'firm').length,
			totalEntities: mergedNodes.filter((node) => node.group === 'entity').length,
			totalNodes: mergedNodes.length,
			totalLinks: mergedLinks.length,
		},
	};

	console.log('Built nodes=', graph.meta.totalNodes, 'links=', graph.meta.totalLinks);
	const saved = await saveGraphArtifacts(graph, { syncRedis });
	console.log('Saved graph artifacts:', saved);
	return graph;
}

// ── Incremental manifest ────────────────────────────────────────────────────
// Tracks which source files have already been processed so that rebuilds only
// re-parse changed or new files rather than the full corpus each time.
const MANIFEST_FILE = path.join(ROOT, 'data', 'build_manifest.json');

async function readManifest() {
	try {
		return JSON.parse(await fs.readFile(MANIFEST_FILE, 'utf-8'));
	} catch {
		return {};
	}
}

async function writeManifest(manifest) {
	await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function getFileMtime(p) {
	try {
		return (await fs.stat(p)).mtimeMs;
	} catch {
		return 0;
	}
}

async function readJsonFilesIncremental(dir, manifest) {
	const out = [];
	const updated = {};
	try {
		const files = await fs.readdir(dir);
		for (const f of files) {
			if (!f.endsWith('.json')) continue;
			const p = path.join(dir, f);
			const mtime = await getFileMtime(p);
			updated[p] = mtime;
			if (manifest[p] && manifest[p] === mtime) continue; // unchanged
			try {
				const raw = await fs.readFile(p, 'utf-8');
				out.push({ file: f, json: JSON.parse(raw) });
			} catch {}
		}
	} catch {}
	return { files: out, mtimes: updated };
}

async function buildIncremental(options = {}) {
	const manifest = await readManifest();
	const { files: finraFiles, mtimes: fMtimes } = await readJsonFilesIncremental(FINRA, manifest);
	const { files: secFiles, mtimes: sMtimes } = await readJsonFilesIncremental(SEC, manifest);

	const newFiles = finraFiles.length + secFiles.length;
	if (newFiles === 0) {
		console.log('build_graph_from_cache: no new/changed files — skipping rebuild');
		return;
	}
	console.log(`build_graph_from_cache: ${newFiles} changed file(s) detected — rebuilding graph`);
	await build(options);
	// Update manifest with new mtimes
	const combined = { ...manifest, ...fMtimes, ...sMtimes };
	await writeManifest(combined);
}

if (require.main === module) {
	const argv = require('minimist')(process.argv.slice(2));
	const forceFull = argv.full || argv.f || false;
	const incrementalFlag = argv.incremental || argv.i || false;
	// Default to incremental unless explicit full requested
	const useIncremental = !forceFull && !incrementalFlag;
	const employmentScope = normalizeEmploymentScope(argv['employment-scope'] || argv.employmentScope || 'current');
	const syncRedis = argv.redis !== false && !(argv['no-redis'] || argv.noRedis);
	const employmentOptions = getEmploymentScopeOptions(employmentScope);

	const start = process.hrtime.bigint();
	const runner = useIncremental ? buildIncremental : build;
	console.log(`build_graph_from_cache: starting ${useIncremental ? 'incremental' : 'full'} run`);
	runner({ employmentOptions, syncRedis })
		.then((res) => {
			const end = process.hrtime.bigint();
			const ms = Number(end - start) / 1_000_000;
			console.log(`build_graph_from_cache: completed in ${ms.toFixed(1)}ms`);
			process.exit(0);
		})
		.catch((e) => {
			const end = process.hrtime.bigint();
			const ms = Number(end - start) / 1_000_000;
			console.error(`build_graph_from_cache: failed after ${ms.toFixed(1)}ms`, e);
			process.exit(1);
		});
}

module.exports = {
	build,
	buildIncremental,
	getEmploymentScopeOptions,
	normalizeEmploymentScope,
	buildSeedBankFromGraph,
	saveGraphArtifacts,
	ensureGraphArtifacts,
};
