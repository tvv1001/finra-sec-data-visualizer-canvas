#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const fsSync = require('node:fs');

const ROOT = process.cwd();
const EXTERNAL_LOCAL = process.env.LOCAL_DATA_DIR || '/home/lenny/Dev/Data/national';
let NATIONAL;
try {
	fsSync.accessSync(EXTERNAL_LOCAL);
	NATIONAL = EXTERNAL_LOCAL;
} catch {
	NATIONAL = path.join(ROOT, 'data', 'national');
}

async function gather() {
	const individuals = new Set();
	const firms = new Set();

	async function addFilesFromDir(dir) {
		try {
			const names = await fs.readdir(dir);
			for (const name of names) {
				if (/^finra-individual-(\d+)\.json$/.test(name)) {
					const id = name.match(/^finra-individual-(\d+)\.json$/)[1];
					individuals.add(id);
				}
				if (/^finra-firm-(\d+)\.json$/.test(name)) {
					const id = name.match(/^finra-firm-(\d+)\.json$/)[1];
					firms.add(id);
				}
				if (/^finra-individual-(\d+)\.json$/.test(name) === false && /^finra-firm-(\d+)\.json$/.test(name) === false) {
					// additional patterns
					const mInd = name.match(/^finra-individual-(\d+)\.json$/);
					if (mInd) individuals.add(mInd[1]);
				}
			}
		} catch (err) {
			// ignore
		}
	}

	// scan top-level national
	await addFilesFromDir(NATIONAL);

	// scan brokercheck.finra.org for firm_<id>.json
	const broker = path.join(NATIONAL, 'brokercheck.finra.org');
	try {
		const bnames = await fs.readdir(broker);
		for (const name of bnames) {
			const m = name.match(/^firm_(\d+)\.json$/);
			if (m) firms.add(m[1]);
		}
	} catch {}

	// scan adviserinfo.sec.gov for firm_*.json and sec_search files that may include individuals
	const sec = path.join(NATIONAL, 'adviserinfo.sec.gov');
	try {
		const snames = await fs.readdir(sec);
		for (const name of snames) {
			const m = name.match(/^firm_(\d+)\.json$/);
			if (m) firms.add(m[1]);
			// sec individual files are named sec_search_<num>_Name.json — can't reliably extract CRD
		}
	} catch {}

	// also look for finra-individual-*.json existing in external dir (grep earlier showed many)
	// normalize to arrays
	return {
		individuals: Array.from(individuals).sort((a, b) => Number(a) - Number(b)),
		firms: Array.from(firms).sort((a, b) => Number(a) - Number(b)),
		source: NATIONAL,
	};
}

async function main() {
	const outDir = path.join(process.cwd(), 'data', 'national');
	try {
		await fs.mkdir(outDir, { recursive: true });
	} catch {}
	const { individuals, firms, source } = await gather();
	const payload = { generatedAt: new Date().toISOString(), source, individuals, firms };
	const outPath = path.join(outDir, 'seed-crds.json');
	await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
	console.log('Wrote', outPath, 'individuals=', individuals.length, 'firms=', firms.length);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
