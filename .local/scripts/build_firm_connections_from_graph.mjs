#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const firmIdArg = process.argv[2] || process.argv[3];
if (!firmIdArg) {
	console.error('Usage: node build_firm_connections_from_graph.mjs <firmId>');
	process.exit(2);
}
const firmId = String(firmIdArg).trim();
const graphPath = path.join(process.cwd(), 'data', 'national', 'finra-graph.json');
if (!fs.existsSync(graphPath)) {
	console.error('Graph file not found:', graphPath);
	process.exit(1);
}

const raw = fs.readFileSync(graphPath, 'utf-8');
let graph;
try {
	graph = JSON.parse(raw);
} catch (e) {
	console.error('Failed to parse graph JSON', e);
	process.exit(1);
}
const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

function firstNonEmpty() {
	for (const a of arguments) {
		if (a === null || a === undefined) continue;
		const s = String(a).trim();
		if (s) return s;
	}
	return '';
}

const current = [];
const previous = [];
const seen = new Set();
for (const node of nodes) {
	try {
		const id = String(node.id || '');
		if (!id.startsWith('person:') && node.group !== 'individual') continue;
		const crd = firstNonEmpty(node.crd, node.basicInformation && node.basicInformation.individualId, id.replace(/^person:/, ''));
		if (!crd) continue;
		const name = firstNonEmpty(node.label, node.name, node.basicInformation && node.basicInformation.name);
		const curr = Array.isArray(node.currentEmployments) ? node.currentEmployments : [];
		const prev = Array.isArray(node.previousEmployments) ? node.previousEmployments : [];
		for (const e of [...curr, ...prev]) {
			const eFirmId = String(firstNonEmpty(e.firmId, e.firm_id, e.firmId)).trim();
			if (!eFirmId) continue;
			if (eFirmId === firmId) {
				const isCurr =
					curr.includes(e) && !prev.includes(e) ? true
					: curr.some((x) => String(firstNonEmpty(x.firmId, x.firm_id)).trim() === firmId) ? true
					: false;
				const key = `${crd}:${isCurr}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const entry = {
					individualId: crd,
					name: name || '',
					relationship: isCurr ? 'Current registration' : 'Previous registration',
					startDate: firstNonEmpty(e.registrationBeginDate, e.startDate) || undefined,
					endDate: firstNonEmpty(e.registrationEndDate, e.endDate) || undefined,
					isCurrent: Boolean(isCurr),
				};
				if (isCurr) current.push(entry);
				else previous.push(entry);
			}
		}
	} catch (e) {
		// ignore
	}
}

const out = { currentConnections: current, previousConnections: previous };
const outDir = path.join(process.cwd(), 'data', 'firm-connections');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${firmId}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('Wrote', outPath, 'current=', current.length, 'previous=', previous.length);
process.exit(0);
