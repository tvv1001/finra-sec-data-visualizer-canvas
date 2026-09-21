#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const ROOT = process.cwd();
const NATIONAL_DIR = path.join(ROOT, 'data', 'national');
const FINRA_DIR = path.join(NATIONAL_DIR, 'brokercheck.finra.org');
const SEC_DIR = path.join(NATIONAL_DIR, 'adviserinfo.sec.gov');
const PRIMED_CACHE_DIR = path.join(NATIONAL_DIR, 'primed-cache');

const INDIVIDUAL_QUERY = 'hl=true&includePrevious=true&wt=json';
const FIRM_QUERY = 'hl=true&wt=json';

const bundles = {
	'finra-individual': {},
	'sec-individual': {},
	'finra-firm': {},
	'sec-firm': {},
};

const patterns = [
	{
		dir: FINRA_DIR,
		regex: /^api\.brokercheck\.finra\.org_search_individual_(\d+)\.json$/,
		bundle: 'finra-individual',
		key: (id) => `finra:individual:${id}:${INDIVIDUAL_QUERY}`,
	},
	{
		dir: SEC_DIR,
		regex: /^api\.adviserinfo\.sec\.gov_search_individual_(\d+)\.json$/,
		bundle: 'sec-individual',
		key: (id) => `sec:individual:${id}:${INDIVIDUAL_QUERY}`,
	},
	{
		dir: FINRA_DIR,
		regex: /^api\.brokercheck\.finra\.org_search_firm_(\d+)\.json$/,
		bundle: 'finra-firm',
		key: (id) => `finra:firm:${id}:${FIRM_QUERY}`,
	},
	{
		dir: SEC_DIR,
		regex: /^api\.adviserinfo\.sec\.gov_search_firm_(\d+)\.json$/,
		bundle: 'sec-firm',
		key: (id) => `sec:firm:${id}:${FIRM_QUERY}`,
	},
];

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function buildBundle({ dir, regex, bundle, key }) {
	let files = [];
	try {
		files = await fs.readdir(dir);
	} catch {
		return 0;
	}

	let count = 0;
	for (const file of files) {
		const match = file.match(regex);
		if (!match) continue;
		try {
			const raw = await fs.readFile(path.join(dir, file), 'utf-8');
			bundles[bundle][key(match[1])] = JSON.parse(raw);
			count += 1;
		} catch {
			// Skip malformed files.
		}
	}
	return count;
}

async function main() {
	// Safety guard: do not run unless explicitly enabled to avoid priming PII into repo artifacts.
	// Set ENABLE_PRIMED_CACHE=true in the environment to opt-in when you intentionally want to generate bundles.
	if (process.env.ENABLE_PRIMED_CACHE !== 'true') {
		console.warn('Primed cache builder skipped: set ENABLE_PRIMED_CACHE=true to enable.');
		return;
	}
	await ensureDir(PRIMED_CACHE_DIR);
	const counts = {};
	for (const pattern of patterns) {
		counts[pattern.bundle] = await buildBundle(pattern);
	}

	const zlib = require('node:zlib');
	for (const [bundleName, data] of Object.entries(bundles)) {
		const jsonPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.json`);
		const binPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.bin`);
		const jsonText = JSON.stringify(data);
		await fs.writeFile(jsonPath, jsonText, 'utf-8');
		const gz = zlib.gzipSync(Buffer.from(jsonText, 'utf-8'));
		await fs.writeFile(binPath, gz);
	}

	await fs.writeFile(
		path.join(PRIMED_CACHE_DIR, 'meta.json'),
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				counts,
			},
			null,
			2,
		),
		'utf-8',
	);

	console.log('Built primed cache bundles:', counts);
}

main().catch((error) => {
	console.error('build_primed_cache_bundle failed:', error);
	process.exit(1);
});
