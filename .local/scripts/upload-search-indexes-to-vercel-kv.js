#!/usr/bin/env node
/**
 * Upload search indexes to Vercel KV (Edge Config or KV Storage)
 * Note: This is a placeholder. Vercel KV has size limits. For production,
 * consider uploading to S3, Cloudflare R2, or using Upstash KV with chunking.
 */

const fs = require('node:fs');
const path = require('node:path');

const files = ['search-index.finra.individual.json', 'search-index.finra.firm.json', 'search-index.sec.individual.json', 'search-index.sec.firm.json'];

const dataDir = path.join(process.cwd(), 'data', 'national');

console.log('Search index upload to Vercel KV would go here.');
console.log('Files available:');

for (const file of files) {
	const filePath = path.join(dataDir, file);
	if (fs.existsSync(filePath)) {
		const stats = fs.statSync(filePath);
		console.log(`  ✓ ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
	} else {
		console.log(`  ✗ ${file} (not found)`);
	}
}

console.log('\nNote: Vercel KV/Edge Config has size limits. Implement one of:');
console.log('  1. Upload to S3 and fetch at runtime');
console.log('  2. Use Upstash KV with chunking strategy');
console.log('  3. Embed in code at build time with gzip compression');
console.log('  4. Fetch from external API at search time');
