#!/usr/bin/env node
console.error(
	'search:indexes:* is retired. Search and name hydration use gzip sidecars under public/search-indexes/ (copied from data/national/search-index.*.json.gz). Do not write search indexes into Redis.',
);
process.exit(0);
