#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = process.cwd();
const dataDir = path.join(root, "data", "national");
const publicDestDir = path.join(root, "public", "search-indexes");

const files = ["search-index.finra.individual.json.gz", "search-index.finra.firm.json.gz", "search-index.sec.individual.json.gz", "search-index.sec.firm.json.gz"];
const maxChunkSize = 90 * 1024 * 1024; // 90 MB

function findSidecarCandidates(fileName) {
	const prefix = fileName.replace(/\.json(?:\.gz)?$/, "");
	const exact = [fileName];
	const extras = [];
	try {
		for (const entry of fs.readdirSync(dataDir)) {
			if (entry === fileName) continue;
			if (entry.startsWith(prefix) && (entry.endsWith(".json") || entry.endsWith(".json.gz") || entry.includes(".part"))) {
				extras.push(entry);
			}
		}
	} catch {
		return exact;
	}
	return [...new Set([...exact, ...extras])];
}

function writeJsonFile(dest, json) {
	fs.writeFileSync(dest, JSON.stringify(json));
}

// Create destination directories
try {
	fs.mkdirSync(publicDestDir, { recursive: true });
} catch (err) {
	console.error("Failed to create destination directories:", err.message);
	process.exit(1);
}

let count = 0;
for (const file of files) {
	const candidates = findSidecarCandidates(file);
	const src = candidates.find((candidate) => fs.existsSync(path.join(dataDir, candidate))) ? path.join(dataDir, candidates.find((candidate) => fs.existsSync(path.join(dataDir, candidate)))) : path.join(dataDir, file);
	const prefix = file.replace(/\.json(?:\.gz)?$/, "");
	const actualFile = path.basename(src);

	try {
		if (!fs.existsSync(src)) {
			if (!process.env.VERCEL) {
				console.warn(`⚠ Source not found: ${src}`);
			}
			continue;
		}

		const stats = fs.statSync(src);
		if (stats.size <= maxChunkSize) {
			const publicDest = path.join(publicDestDir, actualFile);
			fs.copyFileSync(src, publicDest);
			console.log(`✓ Copied ${actualFile}`);
			count++;
			continue;
		}

		console.log(`⚡ Splitting ${actualFile} into chunks for deployment (size ${Math.round(stats.size / 1024 / 1024)} MB)`);
		let raw;
		if (src.endsWith(".gz")) {
			raw = zlib.gunzipSync(fs.readFileSync(src)).toString("utf-8");
		} else {
			raw = fs.readFileSync(src, "utf-8");
		}
		const json = JSON.parse(raw);
		const docs = Array.isArray(json.docs) ? json.docs : [];
		const chunkCount = Math.max(1, Math.ceil(stats.size / maxChunkSize));
		const chunkSize = Math.ceil(docs.length / chunkCount);

		for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
			const chunkDocs = docs.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
			const chunkFileName = `${prefix}.part${chunkIndex}.json`;
			const chunkJson = {
				generatedAt: json.generatedAt,
				bucket: json.bucket,
				docs: chunkDocs,
			};
			const publicChunkDest = path.join(publicDestDir, chunkFileName);

			writeJsonFile(publicChunkDest, chunkJson);
			console.log(`✓ Wrote chunk ${chunkFileName} (${chunkDocs.length} docs)`);
			count++;
		}
	} catch (err) {
		console.error(`✗ Failed to copy or chunk ${file}:`, err.message);
	}
}

console.log(`\nSuccessfully copied/wrote ${count} search index files/chunks to public/search-indexes/`);
