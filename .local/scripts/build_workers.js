#!/usr/bin/env node
/**
 * Bundle the pure JS d3-force layout worker for the browser.
 * Rust/WASM layout has been removed — do not invoke wasm-pack here.
 */
const esbuild = require('esbuild');
const path = require('path');

async function build() {
	const entry = path.join(process.cwd(), 'src', 'workers', 'd3-force-worker-wasm.js');
	const out = path.join(process.cwd(), 'public', 'workers', 'd3-force-worker.js');
	const bundleOut = path.join(process.cwd(), 'public', 'workers', 'd3-force-worker.bundle.js');
	try {
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			minify: true,
			platform: 'browser',
			target: ['es2019'],
			outfile: out,
			format: 'iife',
			sourcemap: false,
		});
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			minify: true,
			platform: 'browser',
			target: ['es2019'],
			outfile: bundleOut,
			format: 'iife',
			sourcemap: false,
		});
		console.log('Built worker:', out);
		console.log('Built worker bundle:', bundleOut);
	} catch (e) {
		console.error('Failed to build worker', e);
		process.exit(1);
	}
}

build();
