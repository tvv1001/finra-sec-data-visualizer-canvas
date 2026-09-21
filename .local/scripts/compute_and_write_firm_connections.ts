#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
// dynamic import at runtime to avoid TS extension resolution issues when running
// this script with different ts-node/node ESM configurations.
// We'll import the module dynamically inside the main function.

// argv will be parsed inside the async main to keep this file ESM/CJS compatible
let firmId = '';

(async () => {
	try {
		// parse argv here (ESM-safe)
		console.log('process.argv:', process.argv.slice(0, 10));
		// Prefer requiring minimist to avoid dynamic-import TS module flags
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const minimist = require('minimist');
		const argv = minimist(process.argv.slice(2));
		console.log('parsed argv:', argv);
		// Defensive: some callers may inject a leading '--' token; remove it if present.
		if (Array.isArray(argv._) && argv._[0] === '--') argv._ = argv._.slice(1);
		// Also drop any leading tokens that look like option flags (e.g. '--firm')
		while (Array.isArray(argv._) && argv._[0] && String(argv._[0]).startsWith('--')) argv._ = argv._.slice(1);
		// Accept --firm, -f, or first positional arg
		firmId = String(argv.firm || argv.f || (Array.isArray(argv._) && argv._[0]) || '').trim();
		// Basic validation: CRD should be numeric
		if (!firmId || !/^[0-9]+$/.test(firmId)) {
			console.error('Usage: --firm <CRD>   (CRD must be numeric)');
			process.exit(2);
		}

		console.log('Computing firm connections for', firmId);
		// dynamic import of graphConnections using tsconfig paths support provided by tsconfig-paths/register
		const mod = await import(path.join(process.cwd(), 'src', 'lib', 'graphConnections')).catch(() => import(path.join(process.cwd(), 'src', 'lib', 'graphConnections.ts')));
		const res = await (mod?.getFirmConnectionsFromGraph ? mod.getFirmConnectionsFromGraph(firmId, { computeIfMissing: true }) : mod?.default?.getFirmConnectionsFromGraph?.(firmId, { computeIfMissing: true }));
		const outDir = path.join(process.cwd(), 'data', 'firm-connections');
		fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, `${firmId}.json`);
		fs.writeFileSync(outPath, JSON.stringify(res));
		console.log('Wrote', outPath, 'current=', res.currentConnections.length, 'previous=', res.previousConnections.length);
	} catch (e) {
		console.error('Error computing connections:', (e as Error)?.message || e);
		process.exit(1);
	}
})();
