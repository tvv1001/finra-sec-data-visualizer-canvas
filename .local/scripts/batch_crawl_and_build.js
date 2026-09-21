#!/usr/bin/env node
const { spawnSync } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const batches = Number(argv.batches || argv.b || 5);
const batchSize = Number(argv.batchSize || argv.size || argv.l || 5000);
const concurrency = String(argv.concurrency || argv.c || 1);
const delay = String(argv.delay || 2000);
const force = argv.force ? '--force' : '';
const pauseMs = Number(argv.pause || 2000);

function runCommand(cmd, args) {
	console.log('\n$ ' + [cmd].concat(args).join(' '));
	const r = spawnSync(cmd, args, { stdio: 'inherit' });
	if (r.error) throw r.error;
	return r.status;
}

(async function main() {
	console.log(`Batch-runner starting: batches=${batches}, batchSize=${batchSize}, concurrency=${concurrency}, delay=${delay}`);

	for (let i = 1; i <= batches; i++) {
		console.log(`\n=== Starting batch ${i}/${batches} ===`);

		const crawlerArgs = ['.local/scripts/parallel_crawler.js', '--concurrency', concurrency, '--delay', delay, '--limit', String(batchSize)];
		if (force) crawlerArgs.push('--force');

		const status = runCommand('node', crawlerArgs);
		if (status !== 0) {
			console.error(`crawler exited with code ${status} (batch ${i}). Continuing to build/merge step.`);
		}

		console.log('Running build_graph_from_cache.js to merge newly fetched data');
		runCommand('node', ['.local/scripts/build_graph_from_cache.js', '--employment-scope', 'all']);

		if (i < batches) {
			console.log(`Pausing ${pauseMs}ms before next batch`);
			await new Promise((r) => setTimeout(r, pauseMs));
		}
	}

	console.log('\nBatch-runner finished');
})();
