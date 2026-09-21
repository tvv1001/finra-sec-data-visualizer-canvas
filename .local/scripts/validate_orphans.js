const fs = require('fs');
const path = require('path');

const root = process.cwd();
const orphanFile = path.join(root, 'orphan_crds.json');
const outFile = path.join(root, 'data', 'orphan_validation_report.json');

function exists(p) {
	try {
		return fs.existsSync(p);
	} catch (e) {
		return false;
	}
}

if (!exists(orphanFile)) {
	console.error('orphan_crds.json not found at', orphanFile);
	process.exit(2);
}

const orphans = JSON.parse(fs.readFileSync(orphanFile, 'utf8'));

const args = process.argv.slice(2);
let checkId = null;
for (const a of args) {
	if (a.startsWith('--check=')) checkId = a.split('=')[1];
}

function walkDir(dir, cb) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === '.git') continue;
			walkDir(full, cb);
		} else {
			cb(full);
		}
	}
}

function searchDataForId(id) {
	const found = [];
	const dataRoot = path.join(root, 'data');
	if (!exists(dataRoot)) return found;
	try {
		walkDir(dataRoot, (file) => {
			const fname = path.basename(file);
			if (fname.includes(id)) {
				found.push(file);
				return;
			}
			// skip large binary or gz files
			if (file.endsWith('.gz') || file.endsWith('.wasm')) return;
			try {
				const stat = fs.statSync(file);
				if (stat.size > 200 * 1024) return; // avoid huge files
				const content = fs.readFileSync(file, 'utf8');
				if (content.indexOf(id) !== -1) found.push(file);
			} catch (e) {
				// ignore unreadable files
			}
		});
	} catch (e) {
		// ignore
	}
	return found;
}

function appearsInFirmConnections(personId) {
	const dir = path.join(root, 'data', 'firm-connections');
	if (!exists(dir)) return false;
	try {
		const files = fs.readdirSync(dir);
		for (const f of files) {
			const full = path.join(dir, f);
			try {
				const stat = fs.statSync(full);
				if (stat.size > 500 * 1024) continue;
				const content = fs.readFileSync(full, 'utf8');
				if (content.indexOf(`"${personId}"`) !== -1 || content.indexOf(personId) !== -1) return true;
			} catch (e) {
				// ignore
			}
		}
	} catch (e) {
		return false;
	}
	return false;
}

const report = {
	generatedAt: new Date().toISOString(),
	individuals: [],
	firms: [],
	summary: {},
};

const indivs = orphans.orphanIndividuals || [];
const firms = orphans.orphanFirms || [];

for (const id of indivs) {
	const finra = path.join(root, 'data', 'national', `finra-individual-${id}.json`);
	const sec = path.join(root, 'data', 'national', `sec-individual-${id}.json`);
	const fetchState = path.join(root, 'data', 'fetch-state', `${id}.json`);
	const foundFinra = exists(finra);
	const foundSec = exists(sec);
	const foundFetch = exists(fetchState);
	const foundPaths = searchDataForId(id);
	const foundInFirmConn = appearsInFirmConnections(id);
	const status = foundFinra || foundSec || foundFetch || foundPaths.length > 0 || foundInFirmConn ? 'not_orphan' : 'orphan_candidate';
	report.individuals.push({ id, foundFinra, foundSec, foundFetch, foundInFirmConn, foundPaths, status });
}

for (const id of firms) {
	const orphanTemplate = path.join(root, 'data', 'national', 'orphan_firms', `api.orphan_firm_${id}.json`);
	const firmConn = path.join(root, 'data', 'firm-connections', `${id}.json`);
	const fetchState = path.join(root, 'data', 'fetch-state', `${id}.json`);
	const foundTemplate = exists(orphanTemplate);
	const foundConn = exists(firmConn);
	const foundFetch = exists(fetchState);
	const foundPaths = searchDataForId(id);
	let status = 'orphan_candidate';
	if (foundConn || foundFetch || foundPaths.length > 0) status = 'not_orphan';
	else if (foundTemplate && !(foundConn || foundFetch || foundPaths.length > 0)) status = 'only_orphan_template';
	report.firms.push({ id, foundTemplate, foundConn, foundFetch, foundPaths, status });
}

report.summary = {
	totalIndividuals: report.individuals.length,
	totalFirms: report.firms.length,
	individuals_not_orphan: report.individuals.filter((i) => i.status === 'not_orphan').length,
	individuals_orphan_candidate: report.individuals.filter((i) => i.status === 'orphan_candidate').length,
	firms_not_orphan: report.firms.filter((f) => f.status === 'not_orphan').length,
	firms_only_orphan_template: report.firms.filter((f) => f.status === 'only_orphan_template').length,
	firms_orphan_candidate: report.firms.filter((f) => f.status === 'orphan_candidate').length,
};

fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log('Wrote orphan validation report to', outFile);

if (checkId) {
	// run focused detection for a single id and print result
	const single = { id: checkId };
	// try as individual
	const finra = path.join(root, 'data', 'national', `finra-individual-${checkId}.json`);
	const sec = path.join(root, 'data', 'national', `sec-individual-${checkId}.json`);
	const fetchState = path.join(root, 'data', 'fetch-state', `${checkId}.json`);
	const foundFinra = exists(finra);
	const foundSec = exists(sec);
	const foundFetch = exists(fetchState);
	const foundPaths = searchDataForId(checkId);
	const foundInFirmConn = appearsInFirmConnections(checkId);
	single.individual = { foundFinra, foundSec, foundFetch, foundInFirmConn, foundPaths };
	// try as firm
	const orphanTemplate = path.join(root, 'data', 'national', 'orphan_firms', `api.orphan_firm_${checkId}.json`);
	const firmConn = path.join(root, 'data', 'firm-connections', `${checkId}.json`);
	const foundTemplate = exists(orphanTemplate);
	const foundConn = exists(firmConn);
	single.firm = { foundTemplate, foundConn };

	console.log('\nFocused detection for id=', checkId);
	console.log(JSON.stringify(single, null, 2));
}
