#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("node:fs");
const path = require("node:path");

function hasJsonFiles(dirPath) {
	try {
		return fs.existsSync(dirPath) && fs.readdirSync(dirPath).some((entry) => entry.endsWith(".json"));
	} catch {
		return false;
	}
}

function canRebuildSearchIndexes() {
	const root = process.cwd();
	const finraNatDir = path.join(root, "data", "national", "brokercheck.finra.org");
	const secNatDir = path.join(root, "data", "national", "adviserinfo.sec.gov");
	const finraRawDir = path.join(root, "data", "raw", "brokercheck.finra.org");
	const secRawDir = path.join(root, "data", "raw", "adviserinfo.sec.gov");
	const hasFinra = hasJsonFiles(finraNatDir) || hasJsonFiles(finraRawDir);
	const hasSec = hasJsonFiles(secNatDir) || hasJsonFiles(secRawDir);
	return (hasFinra && hasSec) || hasJsonFiles(path.join(root, "data", "national"));
}

function getSearchIndexBuilder() {
	const p1 = path.join(process.cwd(), "scripts", "build_search_indexes.js");
	if (fs.existsSync(p1)) return p1;
	return path.join(process.cwd(), ".local", "scripts", "build_search_indexes.js");
}

function runPrimedCacheBuild() {
	const primedBuilder = path.join(process.cwd(), ".local", "scripts", "build_primed_cache_bundle.js");
	if (fs.existsSync(primedBuilder)) {
		execSync(`node ${primedBuilder}`, {
			stdio: "inherit",
			env: {
				...process.env,
				ENABLE_PRIMED_CACHE: "true",
			},
		});
	}
}

function hasLocalGraphArtifact() {
	const graphFile = path.join(process.cwd(), "data", "national", "finra-graph.json");
	return hasJsonFiles(path.dirname(graphFile)) && fs.existsSync(graphFile);
}

function ensureLocalGraphArtifact(reason) {
	if (hasLocalGraphArtifact()) {
		console.log(`Using existing local graph artifact (${reason}).`);
		return;
	}

	console.warn(`No local finra-graph.json available (${reason}); rebuilding graph from local cache instead.`);
	const graphBuilder = path.join(process.cwd(), ".local", "scripts", "build_graph_from_cache.js");
	if (fs.existsSync(graphBuilder)) {
		execSync(`node ${graphBuilder} --employment-scope all --no-redis`, {
			stdio: "inherit",
		});
	} else {
		console.warn("Skipping graph rebuild: .local/scripts/build_graph_from_cache.js is not present in this checkout.");
	}
}

function shouldSkipRemoteGraphSync() {
	if (process.env.VERCEL) return true;
	const explicitUrl = String(process.env.FINRA_LOCAL_URL || "").trim();
	const usingDefaultLocalhost = !explicitUrl || /^https?:\/\/localhost(?::\d+)?\/?$/i.test(explicitUrl);
	return Boolean(process.env.CI) && usingDefaultLocalhost;
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

function isValidUpstashUrl(value) {
	return typeof value === "string" && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes("...");
}

const searchIndexBuilder = getSearchIndexBuilder();

if (url && token) {
	if (!isValidUpstashUrl(url)) {
		console.error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(url)}.\n` + "It must be a real Upstash HTTPS URL like https://<id>.upstash.io");
		process.exit(1);
	}
	console.log("SKIPPING graph rebuild because remote Redis is configured");
	const workersBuilder = path.join(process.cwd(), ".local", "scripts", "build_workers.js");
	if (fs.existsSync(workersBuilder)) {
		execSync(`node ${workersBuilder}`, { stdio: "inherit" });
	}
	if (shouldSkipRemoteGraphSync()) {
		console.log("Skipping remote graph sync and localhost fetch in this build environment.");
		ensureLocalGraphArtifact(process.env.VERCEL ? "Vercel build" : "CI build without FINRA_LOCAL_URL");
	} else {
		try {
			const fetchGraph = path.join(process.cwd(), ".local", "scripts", "fetch_graph_from_server.js");
			if (fs.existsSync(fetchGraph)) {
				execSync(`node ${fetchGraph}`, { stdio: "inherit" });
			} else {
				console.warn(".local/scripts/fetch_graph_from_server.js missing; using local graph artifact.");
				ensureLocalGraphArtifact("missing fetch_graph_from_server");
			}
		} catch (error) {
			console.warn("Remote graph sync failed; falling back to local graph artifact handling.");
			ensureLocalGraphArtifact("remote graph sync failure");
		}
	}
	if (canRebuildSearchIndexes() && fs.existsSync(searchIndexBuilder)) {
		execSync(`node ${searchIndexBuilder}`, {
			stdio: "inherit",
		});
		runPrimedCacheBuild();
	} else {
		console.warn("Skipping search index rebuild because raw source caches are unavailable.");
	}
	process.exit(0);
}

const workersBuilder = path.join(process.cwd(), ".local", "scripts", "build_workers.js");
if (fs.existsSync(workersBuilder)) {
	execSync(`node ${workersBuilder}`, { stdio: "inherit" });
}
const graphBuilder = path.join(process.cwd(), ".local", "scripts", "build_graph_from_cache.js");
if (fs.existsSync(graphBuilder)) {
	execSync(`node ${graphBuilder} --employment-scope all --no-redis`, {
		stdio: "inherit",
	});
} else {
	console.warn("Skipping graph rebuild: .local/scripts/build_graph_from_cache.js is not present in this checkout.");
}

if (canRebuildSearchIndexes() && fs.existsSync(searchIndexBuilder)) {
	execSync(`node ${searchIndexBuilder}`, {
		stdio: "inherit",
	});
	runPrimedCacheBuild();
} else {
	console.warn("Skipping search index rebuild because raw source caches are unavailable.");
}
