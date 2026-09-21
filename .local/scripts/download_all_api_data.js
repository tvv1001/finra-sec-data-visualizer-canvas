#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const ROOT = process.cwd();
const GRAPH_FILE = path.join(ROOT, 'data', 'national', 'finra-graph.json');
const seedGraphUrl = String(argv['seed-graph-url'] || argv.seedGraphUrl || '').trim();

const targetPeople = Number(argv['target-people'] || argv.targetPeople || 27000);
const targetFirms = Number(argv['target-firms'] || argv.targetFirms || 16000);
const targetLinks = Number(argv['target-links'] || argv.targetLinks || 33000);
const batchSize = Number(argv.batchSize || argv.size || argv.limit || 4000);
const concurrency = String(argv.concurrency || argv.c || 8);
const delay = String(argv.delay || argv.d || 120);
const pauseMs = Number(argv.pause || 1500);
const maxBatches = Number(argv.batches || argv.maxBatches || 100);
const forceFlag = argv.force ? '--force' : '';
const noRedisFlag = argv['no-redis'] || argv.noRedis ? '--no-redis' : '';
const forceSeedGraph = Boolean(argv['force-seed-graph'] || argv.forceSeedGraph);

function readGraphStats() {
	try {
		const graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf-8'));
		return {
			people: Number(graph?.meta?.totalIndividuals || 0),
			firms: Number(graph?.meta?.totalFirms || 0),
			links: Number(graph?.meta?.totalLinks || 0),
			nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
		};
	} catch {
		return { people: 0, firms: 0, links: 0, nodes: 0 };
	}
}

function hasReachedTargets(stats) {
	return stats.people >= targetPeople && stats.firms >= targetFirms && stats.links >= targetLinks;
}

function runCapture(cmd, args) {
	console.log('\n$ ' + [cmd].concat(args).join(' '));
	const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
	const out = String(result.stdout || '') + String(result.stderr || '');
	if (out.trim()) console.log(out.trim());
	if (result.error) throw result.error;
	return { status: result.status ?? 0, out };
}

function parsePreparedTasks(output) {
	const match = /Prepared\s+(\d+)\s+tasks/i.exec(output || '');
	return match ? Number(match[1]) : null;
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restoreSeedGraphIfNeeded() {
	if (!seedGraphUrl) return false;
	const current = readGraphStats();
	if (!forceSeedGraph && (current.nodes > 0 || current.links > 0)) return false;

	console.log(`\n=== Bootstrapping local graph from ${seedGraphUrl} ===`);
	const response = await fetch(seedGraphUrl, { headers: { accept: 'application/json' } });
	if (!response.ok) {
		throw new Error(`seed graph fetch failed: HTTP ${response.status}`);
	}
	const graph = await response.json();
	fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2));
	console.log('Seed graph restored locally with stats:', {
		people: graph?.meta?.totalIndividuals || 0,
		firms: graph?.meta?.totalFirms || 0,
		links: graph?.meta?.totalLinks || 0,
		nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
	});
	return true;
}

async function main() {
	console.log(`Prime target: ${targetPeople.toLocaleString()} people / ${targetFirms.toLocaleString()} firms / ${targetLinks.toLocaleString()} links`);
	console.log(`Crawler settings: batchSize=${batchSize}, concurrency=${concurrency}, delay=${delay}ms, maxBatches=${maxBatches}`);

	console.log('\n=== Rebuilding graph from existing cache first ===');
	const initialBuildArgs = ['scripts/build_graph_from_cache.js', '--employment-scope', 'all'];
	if (noRedisFlag) initialBuildArgs.push(noRedisFlag);
	runCapture('node', initialBuildArgs);
	await restoreSeedGraphIfNeeded();

	let stats = readGraphStats();
	console.log('Current graph stats:', stats);
	if (hasReachedTargets(stats)) {
		console.log('Target counts already reached from existing cache.');
		return;
	}

	for (let batch = 1; batch <= maxBatches; batch += 1) {
		console.log(`\n=== Batch ${batch}/${maxBatches} ===`);
		const crawlArgs = ['scripts/parallel_crawler.js', '--concurrency', concurrency, '--delay', delay, '--limit', String(batchSize)];
		if (forceFlag) crawlArgs.push(forceFlag);
		const crawl = runCapture('node', crawlArgs);
		const prepared = parsePreparedTasks(crawl.out);

		if (crawl.status !== 0 && prepared == null) {
			throw new Error(`parallel_crawler exited with status ${crawl.status}`);
		}

		if (prepared === 0) {
			console.log('No additional identifier-led fetch tasks remain.');
			break;
		}

		const buildArgs = ['scripts/build_graph_from_cache.js', '--employment-scope', 'all'];
		if (noRedisFlag) buildArgs.push(noRedisFlag);
		runCapture('node', buildArgs);

		stats = readGraphStats();
		console.log('Updated graph stats:', stats);
		if (hasReachedTargets(stats)) {
			console.log('Target counts reached. Nice.');
			return;
		}

		if (batch < maxBatches) {
			console.log(`Pausing ${pauseMs}ms before the next crawl batch...`);
			await sleep(pauseMs);
		}
	}

	stats = readGraphStats();
	console.log('\nFinished iterative crawl/build run. Final graph stats:', stats);
	if (!hasReachedTargets(stats)) {
		console.log('Targets were not fully reached yet; rerun the script later to continue expanding from the newly discovered identifiers.');
	}
}

main().catch((error) => {
	console.error('download_all_api_data failed:', error);
	process.exit(1);
});
