#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const CSV_PATH = process.argv[2] || '/home/lenny/Dev/webDev/Data-finra-sec/data/all-crds-list.csv';
const API_URL = 'http://localhost:4444/api/dashboard/refresh';

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	console.log(`Reading CSV from ${CSV_PATH}...`);
	const content = await fs.readFile(CSV_PATH, 'utf-8');
	const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
	
	const crds = [];
	for (const line of lines) {
		const [crd] = line.split(',');
		if (crd && /^\d+$/.test(crd)) {
			crds.push(crd);
		}
	}

	console.log(`Loaded ${crds.length} CRDs. Starting sequential crawl via API...`);

	let ok = 0;
	let errors = 0;

	for (let i = 0; i < crds.length; i++) {
		const crd = crds[i];
		console.log(`[${i + 1}/${crds.length}] Fetching CRD ${crd}...`);
		try {
			const res = await fetch(API_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'fetch-crds',
					queries: [crd],
					maxCrds: 1,
					includePayload: false
				})
			});
			
			if (!res.ok) {
				console.warn(`HTTP Error ${res.status} for CRD ${crd}`);
				errors++;
			} else {
				const data = await res.json();
				if (!data.ok) {
					console.warn(`API Error for CRD ${crd}:`, data.error);
					errors++;
				} else {
					const summary = data.summary || {};
					if (summary.newRecordCount > 0 || summary.newSourceCount > 0) {
						console.log(`   -> Saved! (New: ${summary.newRecordCount}, Upd: ${summary.newSourceCount})`);
					} else {
						console.log(`   -> OK (No new changes)`);
					}
					ok++;
				}
			}
		} catch (err) {
			console.error(`Request failed for CRD ${crd}:`, err.message);
			errors++;
		}
		
		// Small polite pause to prevent hammering the local server
		await sleep(500);
	}

	console.log(`\nFinished! OK: ${ok}, Errors: ${errors}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
