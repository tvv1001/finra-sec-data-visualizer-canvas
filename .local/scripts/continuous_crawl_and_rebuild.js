#!/usr/bin/env node
const { spawnSync } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const limit = Number(argv.limit || argv.l || 2000);
const concurrency = String(argv.concurrency || argv.c || 1);
const delay = String(argv.delay || 2000);
const pauseMs = Number(argv.pause || 2000);
const maxIterations = Number(argv.maxIterations || argv.max || 1000);
const forceFlag = argv.force ? '--force' : '';

function runCapture(cmd, args) {
	const proc = spawnSync(cmd, args, { encoding: 'utf8' });
	const out = String(proc.stdout || '') + String(proc.stderr || '');
	return { status: proc.status, out };
}

function runAttach(cmd, args) {
	const r = spawnSync(cmd, args, { stdio: 'inherit' });
	return r.status;
}

console.log(`Continuous crawler: limit=${limit}, concurrency=${concurrency}, delay=${delay}`);

(async function main() {
	for (let iter = 1; iter <= maxIterations; iter++) {
		console.log(`\n--- Iteration ${iter} -- running crawler (limit=${limit})`);
		const crawlArgs = ['.local/scripts/parallel_crawler.js', '--concurrency', concurrency, '--delay', delay, '--limit', String(limit)];
		if (forceFlag) crawlArgs.push('--force');

		const { status, out } = runCapture('node', crawlArgs);
		// Print a short summary to console
		const m = /Prepared\s+(\d+)\s+tasks/i.exec(out);
		const prepared = m ? Number(m[1]) : null;
		console.log(out.split('\n').slice(-6).join('\n'));
		if (prepared === 0) {
			console.log('No prepared tasks; crawl appears complete. Exiting loop.');
			break;
		}
		if (status !== 0 && prepared == null) {
			console.error(`Crawler exited with status=${status} and output could not be parsed; stopping to avoid loops.`);
			break;
		}

		console.log('Running build_graph_from_cache.js to merge newly fetched data');
		runAttach('node', ['.local/scripts/build_graph_from_cache.js', '--employment-scope', 'all']);

		console.log(`Pausing ${pauseMs}ms before next iteration`);
		await new Promise((r) => setTimeout(r, pauseMs));
	}
	console.log('\nContinuous crawler finished');
})();
