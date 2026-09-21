#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// Node 18+ has global fetch available; no external dependency required

const ORPHAN_DIR = path.join(process.cwd(), 'data', 'national', 'orphan_firms');

async function checkFirmFinra(crd) {
	const url = `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(crd)}?hl=true&wt=json`;
	try {
		const res = await fetch(url);
		if (!res.ok) return { ok: false, status: res.status };
		const json = await res.json();
		// hits.total > 0 indicates presence
		const total = json?.hits?.total || 0;
		return { ok: true, found: total > 0, data: json };
	} catch (e) {
		return { ok: false, error: e?.message || String(e) };
	}
}

async function checkFirmSec(crd) {
	const url = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(crd)}?wt=json`;
	try {
		const res = await fetch(url);
		if (!res.ok) return { ok: false, status: res.status };
		const json = await res.json();
		const total = json?.hits?.total || 0;
		return { ok: true, found: total > 0, data: json };
	} catch (e) {
		return { ok: false, error: e?.message || String(e) };
	}
}

async function main() {
	if (!fs.existsSync(ORPHAN_DIR)) {
		console.error('Orphan directory not found:', ORPHAN_DIR);
		process.exit(1);
	}

	const files = fs.readdirSync(ORPHAN_DIR).filter((f) => f.endsWith('.json'));
	console.log('Found orphan files:', files.length);

	const report = [];
	for (const file of files) {
		try {
			const raw = fs.readFileSync(path.join(ORPHAN_DIR, file), 'utf8');
			const parsed = JSON.parse(raw);
			const orphan = parsed.orphan || parsed;
			const crd = String(orphan.crd || orphan.firmId || '').trim();
			const firmName = orphan.firmName || orphan.name || '';
			if (!crd) continue;

			process.stdout.write(`Checking CRD ${crd} (${file})... `);
			const [finraRes, secRes] = await Promise.all([checkFirmFinra(crd), checkFirmSec(crd)]);
			const item = { file, crd, firmName, finra: { ok: finraRes.ok, found: !!finraRes.found }, sec: { ok: secRes.ok, found: !!secRes.found } };
			report.push(item);
			console.log(`FINRA:${item.finra.found ? 'FOUND' : 'no'} SEC:${item.sec.found ? 'FOUND' : 'no'}`);
		} catch (e) {
			console.error('error reading/parsing', file, e?.message || e);
		}
	}

	const outPath = path.join(process.cwd(), 'orphan_live_check_report.json');
	fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
	console.log('Report saved to', outPath);
}

main().catch((e) => {
	console.error('Fatal:', e?.message || e);
	process.exit(1);
});
