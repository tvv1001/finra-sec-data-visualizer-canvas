#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const ROOT = process.cwd();
const SOURCE_FILE = path.resolve(String(argv.source || argv['source-file'] || path.join(ROOT, 'data', 'national', 'seed-crds.json')));
const OUTPUT_DIR = path.resolve(String(argv.out || argv['out-dir'] || path.join(ROOT, 'data', 'national', 'crd-batches')));
const BATCH_SIZE = Math.max(1, Number(argv.size || argv.batchSize || argv.limit || 1000));

function normalizeId(value) {
	return String(value || '')
		.trim()
		.replace(/^person[:_]/i, '')
		.replace(/^firm[:_]/i, '');
}

function uniqueSortedIds(values) {
	return Array.from(new Set(values.map(normalizeId).filter((value) => /^\d+$/.test(value)))).sort((left, right) => Number(left) - Number(right));
}

function chunk(values, size) {
	const chunks = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

async function main() {
	const raw = await fs.readFile(SOURCE_FILE, 'utf-8');
	const parsed = JSON.parse(raw);
	const individuals = uniqueSortedIds(parsed?.individuals || []);
	const firms = uniqueSortedIds(parsed?.firms || []);
	const individualChunks = chunk(individuals, BATCH_SIZE);
	const firmChunks = chunk(firms, BATCH_SIZE);
	const batchTotal = Math.max(individualChunks.length, firmChunks.length, 0);

	await fs.mkdir(OUTPUT_DIR, { recursive: true });

	for (let index = 0; index < batchTotal; index += 1) {
		const batchNumber = index + 1;
		const payload = {
			generatedAt: new Date().toISOString(),
			source: SOURCE_FILE,
			batchSize: BATCH_SIZE,
			batchIndex: batchNumber,
			batchTotal,
			individuals: individualChunks[index] || [],
			firms: firmChunks[index] || [],
		};
		const outPath = path.join(OUTPUT_DIR, `crd-batch-${String(batchNumber).padStart(3, '0')}.json`);
		await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
		console.log(`Wrote ${outPath} (individuals=${payload.individuals.length}, firms=${payload.firms.length})`);
	}

	const manifest = {
		generatedAt: new Date().toISOString(),
		source: SOURCE_FILE,
		outputDir: OUTPUT_DIR,
		batchSize: BATCH_SIZE,
		batchTotal,
		counts: {
			individuals: individuals.length,
			firms: firms.length,
		},
	};
	await fs.writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
	console.log('Wrote batch manifest:', manifest);
}

main().catch((err) => {
	console.error('split_crds_into_batches failed:', err);
	process.exit(1);
});
