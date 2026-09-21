#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const { ensureGraphArtifacts, getEmploymentScopeOptions } = require('./build_graph_from_cache');

const ROOT = process.cwd();
const BASE_API = 'http://localhost:3001';
const GRAPH_FILE = path.join(ROOT, 'data', 'national', 'finra-graph.json');

function personId(crd) {
	return `person:${crd}`;
}
function firmId(id) {
	return `firm:${id}`;
}

async function fetchJson(url) {
	try {
		const r = await axios.get(url, { timeout: 20000 });
		return r.data;
	} catch {
		return null;
	}
}

async function loadGraph() {
	try {
		const raw = await fs.readFile(GRAPH_FILE, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { nodes: [], links: [], meta: {} };
	}
}

async function writeGraph(g) {
	await fs.writeFile(GRAPH_FILE, JSON.stringify(g, null, 2), 'utf-8');
}

async function run(seeds = [], maxDepth = 2) {
	await ensureGraphArtifacts({ employmentOptions: getEmploymentScopeOptions('all'), syncRedis: false });
	const seen = new Set();
	const graph = await loadGraph();
	const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
	const links = graph.links || [];

	const queue = seeds.slice();
	const depthMap = new Map(queue.map((id) => [id, 0]));

	while (queue.length) {
		const id = queue.shift();
		const depth = depthMap.get(id) ?? 0;
		if (depth > maxDepth) continue;
		if (seen.has(id)) continue;
		seen.add(id);

		if (id.startsWith('person:')) {
			const crd = id.split(':')[1];
			const detail = await fetchJson(`${BASE_API}/api/finra/individual/${encodeURIComponent(crd)}`);
			if (!detail || detail?.found === false) continue;
			const name = detail?.basicInformation && [detail.basicInformation.firstName, detail.basicInformation.lastName].filter(Boolean).join(' ');
			nodeMap.set(id, { id, label: name || id, group: 'individual', basicInformation: detail.basicInformation });
			const emps = [...(detail.currentEmployments || []), ...(detail.previousEmployments || []), ...(detail.currentIAEmployments || []), ...(detail.previousIAEmployments || [])];
			for (const e of emps) {
				const fid = e.firmId || e.firm_id || e.bdSECNumber || e.bdSecNumber;
				if (!fid) continue;
				const fidStr = String(fid);
				const fidKey = firmId(fidStr);
				nodeMap.set(fidKey, nodeMap.get(fidKey) || { id: fidKey, label: e.firmName || fidStr, group: 'firm' });
				links.push({ source: id, target: fidKey, type: 'employed_by' });
				if (!seen.has(fidKey) && depth + 1 <= maxDepth) {
					queue.push(fidKey);
					depthMap.set(fidKey, depth + 1);
				}
			}
		} else if (id.startsWith('firm:')) {
			const fid = id.split(':')[1];
			const detail = await fetchJson(`${BASE_API}/api/finra/firm/${encodeURIComponent(fid)}`);
			if (!detail || detail?.found === false) continue;
			const name = detail?.basicInformation?.firmName || id;
			nodeMap.set(id, { id, label: name, group: 'firm', basicInformation: detail?.basicInformation });
			// direct owners
			const owners = detail?.directOwners || [];
			for (const o of owners) {
				if (o.ownerFirmId) {
					const of = String(o.ownerFirmId);
					const key = firmId(of);
					nodeMap.set(key, nodeMap.get(key) || { id: key, label: of, group: 'firm' });
					links.push({ source: key, target: id, type: 'controls' });
					if (!seen.has(key) && depth + 1 <= maxDepth) {
						queue.push(key);
						depthMap.set(key, depth + 1);
					}
				} else if (o.ownerId) {
					const p = String(o.ownerId);
					const key = personId(p);
					nodeMap.set(key, nodeMap.get(key) || { id: key, label: p, group: 'individual' });
					links.push({ source: key, target: id, type: 'controls' });
					if (!seen.has(key) && depth + 1 <= maxDepth) {
						queue.push(key);
						depthMap.set(key, depth + 1);
					}
				}
			}
		}
		await new Promise((r) => setTimeout(r, 100));
	}

	const out = { nodes: Array.from(nodeMap.values()), links, meta: { generated: new Date().toISOString() } };
	await writeGraph(out);
	// invalidate cache via empty append
	try {
		await axios.post(`${BASE_API}/api/finra/graph-append`, { nodes: [], links: [] }, { timeout: 20000 });
	} catch {}
	console.log('Node scraper finished. nodes=', out.nodes.length, 'links=', out.links.length);
}

module.exports = { loadGraph };

if (require.main === module) {
	const args = process.argv.slice(2);
	// seeds can be provided as comma-separated ids, default to person:1008786
	const seeds = (args[0] || 'person:1008786').split(',');
	const depth = Number(args[1] || 2);
	run(seeds, depth).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
