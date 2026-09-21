#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'data', 'national');
const GRAPH_FILE = path.join(BASE, 'finra-graph.json');
const OUT_DIR = path.join(BASE, 'primed-cache');

const SMALL_FIRM_MAX = Number(process.env.PEOPLE_CLUSTER_SMALL_FIRM_MAX || 8);
const MEDIUM_FIRM_MAX = Number(process.env.PEOPLE_CLUSTER_MEDIUM_FIRM_MAX || 25);
const PAIR_FIRM_CAP = Number(process.env.PEOPLE_CLUSTER_PAIR_FIRM_CAP || 60);
const MIN_UNION_SCORE = Number(process.env.PEOPLE_CLUSTER_MIN_SCORE || 3);
const DIRECT_EDGE_WEIGHT = Number(process.env.PEOPLE_CLUSTER_DIRECT_WEIGHT || 3);
const BRIDGE_FIRM_LIMIT = Number(process.env.PEOPLE_CLUSTER_BRIDGE_FIRM_LIMIT || 8);
const ALLOW_MISSING_GRAPH = process.env.PEOPLE_CLUSTER_ALLOW_MISSING_GRAPH === 'true' || process.env.PEOPLE_CLUSTER_ALLOW_MISSING_GRAPH === '1';

function resolveId(ref) {
	if (ref && typeof ref === 'object') return ref.id ?? null;
	return ref ?? null;
}

function isPersonId(id) {
	return typeof id === 'string' && id.startsWith('person:');
}

function isFirmId(id) {
	return typeof id === 'string' && id.startsWith('firm:');
}

function pairKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function sharedFirmWeight(count) {
	if (count <= SMALL_FIRM_MAX) return 3;
	if (count <= MEDIUM_FIRM_MAX) return 2;
	if (count <= PAIR_FIRM_CAP) return 1;
	return 0;
}

function clusterIdFor(parts) {
	const hash = crypto.createHash('sha1');
	for (const part of parts) {
		hash.update(String(part));
		hash.update('\0');
	}
	return `people-cluster-${hash.digest('hex').slice(0, 12)}`;
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function readGraph() {
	const raw = await fs.readFile(GRAPH_FILE, 'utf-8');
	const graph = JSON.parse(raw);
	if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
		throw new Error(`Unexpected graph shape in ${GRAPH_FILE}`);
	}
	return graph;
}

function buildAdjacency(graph) {
	const nodesById = new Map();
	const personNodes = new Map();
	const firmNodes = new Map();
	for (const node of graph.nodes) {
		if (!node || !node.id) continue;
		nodesById.set(node.id, node);
		if (node.group === 'individual' || isPersonId(node.id)) personNodes.set(node.id, node);
		if (node.group === 'firm' || isFirmId(node.id)) firmNodes.set(node.id, node);
	}

	const personFirms = new Map();
	const firmPeople = new Map();
	const directPersonScores = new Map();

	const addPersonFirm = (personId, firmId) => {
		if (!personFirms.has(personId)) personFirms.set(personId, new Set());
		if (!firmPeople.has(firmId)) firmPeople.set(firmId, new Set());
		personFirms.get(personId).add(firmId);
		firmPeople.get(firmId).add(personId);
	};

	const addPersonScore = (a, b, weight) => {
		if (!isPersonId(a) || !isPersonId(b) || a === b || weight <= 0) return;
		const key = pairKey(a, b);
		directPersonScores.set(key, (directPersonScores.get(key) || 0) + weight);
	};

	for (const link of graph.links) {
		const source = resolveId(link.source);
		const target = resolveId(link.target);
		if (!source || !target) continue;

		const sourcePerson = isPersonId(source);
		const targetPerson = isPersonId(target);
		const sourceFirm = isFirmId(source);
		const targetFirm = isFirmId(target);

		if (sourcePerson && targetFirm) {
			addPersonFirm(source, target);
			continue;
		}
		if (sourceFirm && targetPerson) {
			addPersonFirm(target, source);
			continue;
		}
		if (sourcePerson && targetPerson) {
			addPersonScore(source, target, DIRECT_EDGE_WEIGHT);
		}
	}

	return { nodesById, personNodes, firmNodes, personFirms, firmPeople, directPersonScores };
}

function buildPairScores({ firmPeople, directPersonScores }) {
	const scores = new Map(directPersonScores);

	for (const [firmId, peopleSet] of firmPeople.entries()) {
		const people = Array.from(peopleSet).sort();
		if (people.length < 2) continue;
		const weight = sharedFirmWeight(people.length);
		if (weight <= 0) continue;

		for (let i = 0; i < people.length - 1; i += 1) {
			for (let j = i + 1; j < people.length; j += 1) {
				const key = pairKey(people[i], people[j]);
				scores.set(key, (scores.get(key) || 0) + weight);
			}
		}
	}

	return scores;
}

function unionFind(ids) {
	const parent = new Map();
	const rank = new Map();
	for (const id of ids) {
		parent.set(id, id);
		rank.set(id, 0);
	}

	const find = (value) => {
		const current = parent.get(value);
		if (current === value) return value;
		const root = find(current);
		parent.set(value, root);
		return root;
	};

	const union = (a, b) => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA === rootB) return;
		const rankA = rank.get(rootA) || 0;
		const rankB = rank.get(rootB) || 0;
		if (rankA < rankB) {
			parent.set(rootA, rootB);
			return;
		}
		if (rankA > rankB) {
			parent.set(rootB, rootA);
			return;
		}
		parent.set(rootB, rootA);
		rank.set(rootA, rankA + 1);
	};

	return { find, union };
}

function buildClusters({ personNodes, firmNodes, personFirms, firmPeople, pairScores }) {
	const personIds = Array.from(personNodes.keys()).sort();
	const { find, union } = unionFind(personIds);

	for (const [key, score] of pairScores.entries()) {
		if (score < MIN_UNION_SCORE) continue;
		const [a, b] = key.split('|');
		if (a && b) union(a, b);
	}

	const groups = new Map();
	for (const personId of personIds) {
		const root = find(personId);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(personId);
	}

	const clusters = [];
	for (const people of groups.values()) {
		const firmHits = new Map();
		for (const personId of people) {
			for (const firmId of personFirms.get(personId) || []) {
				firmHits.set(firmId, (firmHits.get(firmId) || 0) + 1);
			}
		}

		let bridgeFirms = Array.from(firmHits.entries())
			.filter(([, count]) => count >= 2)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([firmId]) => firmId)
			.slice(0, BRIDGE_FIRM_LIMIT);

		if (bridgeFirms.length === 0 && people.length === 1) {
			bridgeFirms = Array.from(personFirms.get(people[0]) || [])
				.sort((a, b) => {
					const aCount = firmPeople.get(a)?.size || 0;
					const bCount = firmPeople.get(b)?.size || 0;
					return aCount - bCount || a.localeCompare(b);
				})
				.slice(0, BRIDGE_FIRM_LIMIT);
		}

		const selectedIds = new Set([...people, ...bridgeFirms]);
		const nodes = [];
		const links = [];
		for (const node of personNodes.values()) {
			if (selectedIds.has(node.id)) nodes.push(node);
		}
		for (const firmId of bridgeFirms) {
			const node = firmNodes.get(firmId);
			if (node) nodes.push(node);
		}

		clusters.push({
			people: people.slice().sort(),
			bridgeFirms,
			nodes,
			links,
		});
	}

	return clusters;
}

function buildClusterLinks(graphLinks, selectedIds) {
	const links = [];
	for (const link of graphLinks) {
		const source = resolveId(link.source);
		const target = resolveId(link.target);
		if (!source || !target) continue;
		if (!selectedIds.has(source) || !selectedIds.has(target)) continue;
		links.push(link);
	}
	return links;
}

async function writeBundle(name, payload) {
	const baseName = path.basename(String(name || '')).replace(/\.(json|bin)$/i, '');
	const jsonPath = path.join(OUT_DIR, `${baseName}.json`);
	const binPath = path.join(OUT_DIR, `${baseName}.bin`);
	const jsonText = JSON.stringify(payload, null, 2);
	await fs.writeFile(jsonPath, jsonText, 'utf-8');
	await fs.writeFile(binPath, zlib.gzipSync(Buffer.from(jsonText, 'utf-8')));
	return {
		jsonPath,
		binPath,
		bytes: Buffer.byteLength(jsonText, 'utf-8'),
	};
}

async function main() {
	await ensureDir(OUT_DIR);
	let graph;
	try {
		graph = await readGraph();
	} catch (error) {
		if (ALLOW_MISSING_GRAPH && /Missing graph file|ENOENT/i.test(error.message || '')) {
			console.warn(`Skipping people-cluster build because ${GRAPH_FILE} is missing.`);
			return;
		}
		throw error;
	}
	const adjacency = buildAdjacency(graph);
	const pairScores = buildPairScores(adjacency);
	const clusters = buildClusters({ ...adjacency, pairScores });

	const clusterEntries = [];
	const personToCluster = {};

	for (const cluster of clusters) {
		const selectedIds = new Set([...cluster.people, ...cluster.bridgeFirms]);
		const clusterId = clusterIdFor([...cluster.people, ...cluster.bridgeFirms]);
		const links = buildClusterLinks(graph.links, selectedIds);
		const nodes = [...cluster.people.map((id) => adjacency.personNodes.get(id)).filter(Boolean), ...cluster.bridgeFirms.map((id) => adjacency.firmNodes.get(id)).filter(Boolean)];
		const payload = {
			clusterId,
			people: cluster.people,
			bridgeFirms: cluster.bridgeFirms,
			nodes,
			links,
			stats: {
				people: cluster.people.length,
				bridgeFirms: cluster.bridgeFirms.length,
				links: links.length,
			},
		};
		const written = await writeBundle(clusterId, payload);
		for (const personId of cluster.people) personToCluster[personId] = clusterId;
		clusterEntries.push({
			clusterId,
			people: cluster.people,
			bridgeFirms: cluster.bridgeFirms,
			stats: payload.stats,
			bundle: {
				json: path.basename(written.jsonPath),
				bin: path.basename(written.binPath),
			},
		});
	}

	const manifest = {
		generatedAt: new Date().toISOString(),
		sourceGraph: path.relative(ROOT, GRAPH_FILE),
		thresholds: {
			smallFirmMax: SMALL_FIRM_MAX,
			mediumFirmMax: MEDIUM_FIRM_MAX,
			pairFirmCap: PAIR_FIRM_CAP,
			minUnionScore: MIN_UNION_SCORE,
			directEdgeWeight: DIRECT_EDGE_WEIGHT,
			bridgeFirmLimit: BRIDGE_FIRM_LIMIT,
		},
		clusterCount: clusterEntries.length,
		personCount: adjacency.personNodes.size,
		firmCount: adjacency.firmNodes.size,
		clusters: clusterEntries,
		personToCluster,
	};

	await writeBundle(path.join(OUT_DIR, 'people-cluster-map'), manifest);
	console.log(`Built ${clusterEntries.length} people clusters from ${adjacency.personNodes.size} people nodes.`);
}

main().catch((error) => {
	console.error('build_people_clusters failed:', error);
	process.exit(1);
});
