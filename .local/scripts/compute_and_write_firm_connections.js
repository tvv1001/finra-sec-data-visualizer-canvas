#!/usr/bin/env node
'use strict';
// Compute firm connections using existing local data and write to data/firm-connections/{firmId}.json
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const fs = require('fs');
const path = require('path');
const { getFirmConnectionsFromGraph } = require('../src/lib/graphConnections.ts');

const argv = require('minimist')(process.argv.slice(2));
const firmId = String(argv.firm || argv.f || '').trim();
if (!firmId) {
	console.error('Usage: --firm <CRD>');
	process.exit(2);
}

(async () => {
	try {
		console.log('Computing firm connections for', firmId);
		const res = await getFirmConnectionsFromGraph(firmId, { computeIfMissing: true });
		const outDir = path.join(process.cwd(), 'data', 'firm-connections');
		fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, `${firmId}.json`);
		fs.writeFileSync(outPath, JSON.stringify(res));
		console.log('Wrote', outPath, 'current=', res.currentConnections.length, 'previous=', res.previousConnections.length);
	} catch (e) {
		console.error('Error computing connections:', e?.message || e);
		process.exit(1);
	}
})();
