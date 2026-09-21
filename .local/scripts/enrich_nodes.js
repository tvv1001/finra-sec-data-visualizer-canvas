#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { ensureGraphArtifacts, getEmploymentScopeOptions } = require('./build_graph_from_cache');

const ROOT = process.cwd();
const GRAPH_FILE = path.join(ROOT, 'data', 'national', 'finra-graph.json');
const BASE_API = process.env.LOCAL_APP_URL || 'http://localhost:4444';

async function readGraph() {
	const raw = await fs.readFile(GRAPH_FILE, 'utf-8');
	return JSON.parse(raw);
}

async function writeGraph(g) {
	await fs.writeFile(GRAPH_FILE, JSON.stringify(g, null, 2), 'utf-8');
}

function extractId(node) {
	if (!node || !node.id) return null;
	const m = node.id.match(/[:_](\d+)$/);
	return m ? m[1] : null;
}

async function enrich() {
	await ensureGraphArtifacts({ employmentOptions: getEmploymentScopeOptions('all'), syncRedis: false });
	const graph = await readGraph();
	const nodes = graph.nodes || [];
	for (const node of nodes) {
		try {
			if (node.group === 'individual') {
				const crd = extractId(node);
				if (!crd) continue;
				const url = `${BASE_API}/api/finra/individual/${encodeURIComponent(crd)}`;
				const res = await axios.get(url, { timeout: 20000 });
				if (res.status === 200 && res.data) {
					const detail = res.data;
					if (detail?.found === false) continue;
					const bi = detail?.basicInformation || {};
					const fullName = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ');
					if (fullName) node.label = fullName;
					node.basicInformation = bi;
					node.currentEmployments = detail.currentEmployments || node.currentEmployments;
					node.previousEmployments = detail.previousEmployments || node.previousEmployments;
					node.firmCount = detail.firmCount || node.firmCount;
				}
			} else if (node.group === 'firm') {
				const fid = extractId(node);
				if (!fid) continue;
				const url = `${BASE_API}/api/finra/firm/${encodeURIComponent(fid)}`;
				const res = await axios.get(url, { timeout: 20000 });
				if (res.status === 200 && res.data) {
					const detail = res.data;
					if (detail?.found === false) continue;
					const bi = detail?.basicInformation || {};
					if (bi.firmName) node.label = bi.firmName;
					node.basicInformation = bi;
					node.disclosures = detail.disclosures || node.disclosures;
					node.directOwners = detail.directOwners || node.directOwners;
					node.activeStates = detail.activeStates || node.activeStates;
				}
			}
		} catch (e) {
			console.warn('enrich failed for', node.id, e.message);
		}
		// small delay to avoid overwhelming local server
		await new Promise((r) => setTimeout(r, 50));
	}

	await writeGraph(graph);

	// POST empty append to invalidate server cache
	try {
		await axios.post(`${BASE_API}/api/finra/graph-append`, { nodes: [], links: [] }, { timeout: 20000 });
		console.log('Wrote enriched graph and invalidated cache');
	} catch (e) {
		console.warn('Failed to call graph-append to invalidate cache:', e.message);
	}
}

if (require.main === module)
	enrich().catch((e) => {
		console.error(e);
		process.exit(1);
	});
