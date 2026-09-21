/**
 * Low-frequency Redis-cache-only reverse index runner.
 *
 * Usage:
 *   pnpm run reverse-index:firm-connections
 *   pnpm run reverse-index:firm-connections -- --batch=100 --writes=80 --loops=5
 *   pnpm run reverse-index:firm-connections -- --reset
 *
 * No external FINRA/SEC calls. Advances a durable SCAN cursor in Redis.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
	try {
		const envPath = path.join(process.cwd(), '.env.local');
		if (!fs.existsSync(envPath)) return;
		for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq <= 0) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (process.env[key] == null) process.env[key] = value;
		}
	} catch {
		/* ignore */
	}
}

function readArg(name: string, fallback?: string) {
	const args = process.argv.filter((arg) => arg !== '--');
	const prefix = `--${name}=`;
	const hit = args.find((arg) => arg.startsWith(prefix));
	if (hit) return hit.slice(prefix.length);
	const idx = args.indexOf(`--${name}`);
	if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
	return fallback;
}

async function main() {
	loadEnvLocal();
	if (process.env.USE_LOCAL_REDIS == null) process.env.USE_LOCAL_REDIS = '1';

	const { runFirmConnectionsReverseIndexPass } = require('../src/lib/firmConnectionsReverseIndex');

	const batchSize = Number(readArg('batch', '100'));
	const maxFirmWrites = Number(readArg('writes', '80'));
	const loops = Math.max(1, Number(readArg('loops', '1')));
	const resetCursor = process.argv.includes('--reset');

	console.log('[reverse-index] starting', {
		USE_LOCAL_REDIS: process.env.USE_LOCAL_REDIS,
		batchSize,
		maxFirmWrites,
		loops,
		resetCursor,
	});

	for (let i = 0; i < loops; i++) {
		const result = await runFirmConnectionsReverseIndexPass({
			batchSize,
			maxFirmWrites,
			resetCursor: resetCursor && i === 0,
			updateCrdLog: true,
		});
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
				processedIndividuals: result.state.processedIndividuals,
				firmsWritten: result.state.firmsWritten,
				firmsSkippedUnchanged: result.state.firmsSkippedUnchanged,
				cycle: result.state.cycle,
			},
		});
		if (result.doneCycle && i < loops - 1) {
			console.log('[reverse-index] completed a full cycle; continuing remaining loops from the top');
		}
	}
}

main().catch((err) => {
	console.error('[reverse-index] failed', err);
	process.exit(1);
});
