#!/usr/bin/env node
// Monthly maintenance: validate firm-connections, queue outdated firms for full
// rebuild, and produce a maintenance report in data/maintenance/.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FIRM_CONN = path.join(ROOT, 'data', 'firm-connections');
const MAINT_DIR = path.join(ROOT, 'data', 'maintenance');

function ensureMaintenanceDir() {
	if (!fs.existsSync(MAINT_DIR)) fs.mkdirSync(MAINT_DIR, { recursive: true });
}

function isOutdated(filePath, days = 30) {
	try {
		const st = fs.statSync(filePath);
		const ageMs = Date.now() - st.mtimeMs;
		return ageMs > days * 24 * 60 * 60 * 1000;
	} catch (e) {
		return true;
	}
}

function scanFirmConnections() {
	const ids = [];
	if (!fs.existsSync(FIRM_CONN)) return ids;
	const files = fs.readdirSync(FIRM_CONN);
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		const p = path.join(FIRM_CONN, f);
		const id = f.replace(/\.json$/, '');
		ids.push({ id, path: p, outdated: isOutdated(p, 30) });
	}
	return ids;
}

function main() {
	ensureMaintenanceDir();
	const all = scanFirmConnections();
	const outdated = all.filter((a) => a.outdated).map((a) => a.id);
	const report = {
		updatedAt: new Date().toISOString(),
		totalFirmConnections: all.length,
		outdatedCount: outdated.length,
		outdated: outdated.slice(0, 100), // sample
	};
	fs.writeFileSync(path.join(MAINT_DIR, 'monthly-report.json'), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(MAINT_DIR, 'needs-rebuild.json'), JSON.stringify(outdated, null, 2));
	console.log('monthly maintenance: total firm-connections=', all.length, 'outdated=', outdated.length);
	console.log('Wrote maintenance artifacts to data/maintenance/');
	console.log('To rebuild outdated firms, run the existing TypeScript worker script per-firm, e.g.:');
	console.log(
		`TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' node -r ts-node/register -r tsconfig-paths/register scripts/compute_and_write_firm_connections.ts -- --firm <CRD>`,
	);
}

main();
