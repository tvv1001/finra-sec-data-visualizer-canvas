#!/usr/bin/env node
/**
 * generate-crd-log.js
 *
 * Scans data/raw/ for all finra:firm:<CRD>.json and finra:individual:<CRD>.json
 * files, extracts names, merges into data/crd-log.json, and updates counts.
 *
 * The log is additive — CRDs are never removed once recorded.
 * Names are extracted server-side only; the log is not exposed to the client.
 * Run any time after new raw files are added.
 *
 * Usage:
 *   node scripts/generate-crd-log.js
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const LOG_FILE = path.join(ROOT, 'data', 'crd-log.json');
const BATCH_SIZE = 300;

/** Read existing log — handles both old (number[]) and new ({id,name}[]) formats. */
function readExistingLog() {
	if (!fs.existsSync(LOG_FILE)) return { individuals: new Map(), firms: new Map() };
	try {
		const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
		const toMap = (arr) => {
			const m = new Map();
			for (const entry of Array.isArray(arr) ? arr : []) {
				if (typeof entry === 'object' && entry !== null) m.set(Number(entry.id), entry.name || '');
				else if (typeof entry === 'number') m.set(entry, '');
			}
			return m;
		};
		return {
			individuals: toMap(parsed.individuals),
			firms: toMap(parsed.firms),
		};
	} catch {
		console.warn('Warning: could not parse existing crd-log.json — starting fresh.');
		return { individuals: new Map(), firms: new Map() };
	}
}

/** Extract a name from a raw detail file without retaining the full payload. */
async function extractName(filePath, entity) {
	try {
		const text = await fsPromises.readFile(filePath, 'utf8');
		const data = JSON.parse(text);
		const bi = data?.content?.basicInformation || data?.basicInformation || {};
		if (entity === 'firm') return String(bi.firmName || '').trim();
		const parts = [bi.firstName, bi.lastName].filter(Boolean).map((s) => String(s).trim());
		return parts.join(' ');
	} catch {
		return '';
	}
}

/** Scan data/raw/ recursively and return arrays of { id, file } grouped by entity. */
function scanRawDir() {
	const firms = [];
	const individuals = [];

	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
				continue;
			}
			const firmMatch = ent.name.match(/^finra:firm:(\d+)\.json$/);
			if (firmMatch) {
				firms.push({ id: Number(firmMatch[1]), file: full });
				continue;
			}
			const indivMatch = ent.name.match(/^finra:individual:(\d+)\.json$/);
			if (indivMatch) {
				individuals.push({ id: Number(indivMatch[1]), file: full });
			}
		}
	}

	walk(RAW_DIR);
	return { firms, individuals };
}

/** Run fn over items in parallel batches of BATCH_SIZE. */
async function batchMap(items, fn) {
	const results = new Array(items.length);
	for (let i = 0; i < items.length; i += BATCH_SIZE) {
		const batch = items.slice(i, i + BATCH_SIZE);
		const resolved = await Promise.all(batch.map(fn));
		for (let j = 0; j < resolved.length; j++) results[i + j] = resolved[j];
		process.stdout.write(`\r  reading... ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}`);
	}
	process.stdout.write('\n');
	return results;
}

async function main() {
	const existing = readExistingLog();
	const scanned = scanRawDir();

	// Only read files we haven't processed yet (name is blank) or are new
	const newFirmItems = scanned.firms.filter((f) => !existing.firms.has(f.id) || !existing.firms.get(f.id));
	const newIndivItems = scanned.individuals.filter((f) => !existing.individuals.has(f.id) || !existing.individuals.get(f.id));

	console.log(`Firms  : ${scanned.firms.length.toLocaleString()} total, ${newFirmItems.length.toLocaleString()} need name extraction`);
	console.log(`Indivs : ${scanned.individuals.length.toLocaleString()} total, ${newIndivItems.length.toLocaleString()} need name extraction`);

	if (newFirmItems.length > 0) {
		console.log('Extracting firm names...');
		const names = await batchMap(newFirmItems, (f) => extractName(f.file, 'firm'));
		for (let i = 0; i < newFirmItems.length; i++) existing.firms.set(newFirmItems[i].id, names[i]);
	}

	if (newIndivItems.length > 0) {
		console.log('Extracting individual names...');
		const names = await batchMap(newIndivItems, (f) => extractName(f.file, 'individual'));
		for (let i = 0; i < newIndivItems.length; i++) existing.individuals.set(newIndivItems[i].id, names[i]);
	}

	// Merge existing log entries for CRDs no longer in raw (additive)
	const firmIds = new Set([...existing.firms.keys(), ...scanned.firms.map((f) => f.id)]);
	const indivIds = new Set([...existing.individuals.keys(), ...scanned.individuals.map((f) => f.id)]);

	const sortedFirms = [...firmIds].sort((a, b) => a - b).map((id) => ({ id, name: existing.firms.get(id) || '' }));
	const sortedIndividuals = [...indivIds].sort((a, b) => a - b).map((id) => ({ id, name: existing.individuals.get(id) || '' }));

	const prevFirmCount = [...existing.firms.keys()].length;
	const prevIndivCount = [...existing.individuals.keys()].length;

	const log = {
		updatedAt: new Date().toISOString(),
		summary: {
			firms: sortedFirms.length,
			individuals: sortedIndividuals.length,
			total: sortedFirms.length + sortedIndividuals.length,
		},
		firms: sortedFirms,
		individuals: sortedIndividuals,
	};

	fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n');

	console.log(`\ncrd-log.json updated`);
	console.log(`  firms       : ${sortedFirms.length.toLocaleString()} (+${sortedFirms.length - prevFirmCount})`);
	console.log(`  individuals : ${sortedIndividuals.length.toLocaleString()} (+${sortedIndividuals.length - prevIndivCount})`);
	console.log(`  total       : ${log.summary.total.toLocaleString()}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
