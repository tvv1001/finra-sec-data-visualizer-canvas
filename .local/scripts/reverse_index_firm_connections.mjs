#!/usr/bin/env node
/**
 * OPTIONAL bulk scan — not the normal update path.
 *
 * Prefer: open the individual page / call GET /api/finra/individual/{crd}
 * which upserts that person into employer firm-connections.
 *
 * This script walks all Redis individuals via the reverse-index API.
 * Usage (dev server on :4444):
 *   pnpm run firm-connections:reverse-index:optional
 *   pnpm run firm-connections:reverse-index:optional -- --batch=50 --writes=40 --loops=10
 *   pnpm run firm-connections:reverse-index:optional -- --reset
 */
import minimist from 'minimist';

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const argv = minimist(rawArgs);
const batchSize = Math.max(1, Number(argv.batch || argv.batchSize || 50));
const maxFirmWrites = Math.max(1, Number(argv.writes || argv.maxFirmWrites || 40));
const loops = Math.max(1, Number(argv.loops || 1));
const reset = Boolean(argv.reset);
const base = String(argv.base || process.env.REVERSE_INDEX_BASE_URL || 'http://127.0.0.1:4444').replace(/\/$/, '');

async function onePass(resetCursor) {
	const url = new URL('/api/finra/firm-connections-reverse-index', base);
	url.searchParams.set('batchSize', String(batchSize));
	url.searchParams.set('maxFirmWrites', String(maxFirmWrites));
	if (resetCursor) url.searchParams.set('reset', '1');

	const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.ok) {
		throw new Error(body?.error || `HTTP ${res.status}`);
	}
	return body;
}

console.log('[reverse-index] starting', { base, batchSize, maxFirmWrites, loops, reset });

for (let i = 0; i < loops; i++) {
	const result = await onePass(reset && i === 0);
	console.log(`[reverse-index] pass ${i + 1}/${loops}`, {
		pattern: result.pattern,
		keysScanned: result.keysScanned,
		individualsProcessed: result.individualsProcessed,
		individualsWithEmployment: result.individualsWithEmployment,
		firmsWritten: result.firmsWritten,
		firmsSkippedUnchanged: result.firmsSkippedUnchanged,
		cursor: `${result.cursorStart} -> ${result.cursorEnd}`,
		doneCycle: result.doneCycle,
		totals: {
			processedIndividuals: result.state?.processedIndividuals,
			firmsWritten: result.state?.firmsWritten,
			firmsSkippedUnchanged: result.state?.firmsSkippedUnchanged,
			cycle: result.state?.cycle,
		},
	});
	if (result.doneCycle && i < loops - 1) {
		console.log('[reverse-index] completed a full cycle; continuing remaining loops from the top');
	}
}
