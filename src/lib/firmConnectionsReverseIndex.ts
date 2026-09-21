/**
 * Low-frequency, Redis-cache-only reverse index:
 * walk cached individual records and upsert person→employer firm-connections.
 *
 * Design goals:
 * - No external FINRA/SEC calls
 * - Cursor-based SCAN so each run is small (cheap on Upstash)
 * - Skip unchanged firm-connections membership (minimize writes)
 * - Safe to run monthly / manually against local Redis
 */
import { getRedisClient, decompressPayload } from '@/lib/redisCache';
import {
	extractIndividualEmployerLinksFromDetail,
	unwrapCachedIndividualDetail,
	upsertIndividualIntoEmployerFirmConnections,
} from '@/lib/graphConnections';
import { rememberCrdLogEntries } from '@/lib/crdLog';

const PATTERNS = ['finra:individual:*', 'sec:individual:*'] as const;

export type ReverseIndexState = {
	cursor: string;
	patternIndex: number;
	processedIndividuals: number;
	firmsWritten: number;
	firmsSkippedUnchanged: number;
	updatedAt: string;
	cycle: number;
};

export type ReverseIndexRunOptions = {
	/** Individuals to process this run (default 25 cron / pass explicitly for local). */
	batchSize?: number;
	/** Redis SCAN COUNT hint (default 64). */
	scanCount?: number;
	/** Cap firm-connection writes this run (default 40). */
	maxFirmWrites?: number;
	/** Reset cursor to start of finra:individual:* */
	resetCursor?: boolean;
	/** Persist CRD log inventory for touched people/firms (default true). */
	updateCrdLog?: boolean;
};

export type ReverseIndexRunResult = {
	ok: true;
	redisOnly: true;
	pattern: string;
	cursorStart: string;
	cursorEnd: string;
	keysScanned: number;
	individualsProcessed: number;
	individualsWithEmployment: number;
	firmsWritten: number;
	firmsSkippedUnchanged: number;
	doneCycle: boolean;
	state: ReverseIndexState;
};

function defaultState(): ReverseIndexState {
	return {
		cursor: '0',
		patternIndex: 0,
		processedIndividuals: 0,
		firmsWritten: 0,
		firmsSkippedUnchanged: 0,
		updatedAt: new Date().toISOString(),
		cycle: 0,
	};
}

function parseState(raw: unknown): ReverseIndexState {
	if (raw == null) return defaultState();
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return defaultState();
		}
	}
	if (!data || typeof data !== 'object') return defaultState();
	return {
		cursor: String(data.cursor ?? '0'),
		patternIndex: Number.isFinite(Number(data.patternIndex)) ? Number(data.patternIndex) % PATTERNS.length : 0,
		processedIndividuals: Math.max(0, Number(data.processedIndividuals) || 0),
		firmsWritten: Math.max(0, Number(data.firmsWritten) || 0),
		firmsSkippedUnchanged: Math.max(0, Number(data.firmsSkippedUnchanged) || 0),
		updatedAt: String(data.updatedAt || new Date().toISOString()),
		cycle: Math.max(0, Number(data.cycle) || 0),
	};
}

function crdFromIndividualKey(key: string): string {
	const match = String(key || '').match(/^(?:finra|sec):individual:(\d{1,10})$/);
	return match?.[1] || '';
}

async function scanPage(
	redis: NonNullable<ReturnType<typeof getRedisClient>>,
	cursor: string,
	pattern: string,
	count: number,
): Promise<{ nextCursor: string; keys: string[] }> {
	const result = await (redis as any).scan(cursor, { match: pattern, count });
	if (Array.isArray(result) && result.length >= 2) {
		return { nextCursor: String(result[0]), keys: Array.isArray(result[1]) ? result[1].map(String) : [] };
	}
	// Some clients return { cursor, keys }
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		return {
			nextCursor: String((result as any).cursor ?? '0'),
			keys: Array.isArray((result as any).keys) ? (result as any).keys.map(String) : [],
		};
	}
	return { nextCursor: '0', keys: [] };
}

function decodeRedisValue(raw: unknown): any {
	if (raw == null) return null;
	let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
	if (text.startsWith('br:')) {
		try {
			text = decompressPayload(text);
		} catch {
			return null;
		}
	}
	try {
		return typeof text === 'string' ? JSON.parse(text) : text;
	} catch {
		return null;
	}
}

/**
 * One cheap Redis-only pass: SCAN a page of cached individuals, upsert employer
 * firm-connections only when membership changed, advance a durable cursor.
 */
export async function runFirmConnectionsReverseIndexPass(
	options: ReverseIndexRunOptions = {},
): Promise<ReverseIndexRunResult> {
	const redis = getRedisClient();
	if (!redis) {
		throw new Error('Redis client unavailable (configure USE_LOCAL_REDIS or Upstash env)');
	}

	const batchSize = Math.max(1, Math.min(200, Number(options.batchSize) || 25));
	const scanCount = Math.max(10, Math.min(500, Number(options.scanCount) || 64));
	const maxFirmWrites = Math.max(1, Math.min(200, Number(options.maxFirmWrites) || 40));
	const updateCrdLog = options.updateCrdLog !== false;

	const state = defaultState();
	const pattern = PATTERNS[state.patternIndex] || PATTERNS[0];
	const cursorStart = state.cursor || '0';

	const page = await scanPage(redis, cursorStart, pattern, scanCount);
	const individualKeys = page.keys.filter((key) => crdFromIndividualKey(key));
	const keysToProcess = individualKeys.slice(0, batchSize);

	let individualsProcessed = 0;
	let individualsWithEmployment = 0;
	let firmsWritten = 0;
	let firmsSkippedUnchanged = 0;
	const crdLogEntries: Array<{ kind: 'firm' | 'individual'; id: string | number; name?: string }> = [];

	for (const key of keysToProcess) {
		const crd = crdFromIndividualKey(key);
		if (!crd) continue;
		individualsProcessed += 1;

		const raw = await redis.get(key).catch(() => null);
		const parsed = decodeRedisValue(raw);
		const detail = unwrapCachedIndividualDetail(parsed);
		if (!detail || typeof detail !== 'object') continue;

		const links = extractIndividualEmployerLinksFromDetail(detail);
		if (!links.length) continue;
		individualsWithEmployment += 1;

		const remainingWrites = Math.max(0, maxFirmWrites - firmsWritten);
		if (remainingWrites <= 0) break;

		const result = await upsertIndividualIntoEmployerFirmConnections(crd, detail, {
			skipUnchanged: true,
			evidenceTag: 'reverse-index-redis-only',
			maxFirmWrites: remainingWrites,
		});
		firmsWritten += result.firmsTouched.length;
		firmsSkippedUnchanged += result.firmsSkippedUnchanged.length;

		if (updateCrdLog) {
			const bi: any = detail.basicInformation || {};
			const name = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ');
			crdLogEntries.push({ kind: 'individual', id: crd, name });
			for (const link of links) {
				crdLogEntries.push({ kind: 'firm', id: link.firmId, name: link.firmName });
			}
		}
	}

	let nextCursor = page.nextCursor;
	let nextPatternIndex = state.patternIndex;
	let doneCycle = false;
	let cycle = state.cycle;

	// If this SCAN page is exhausted, advance pattern or finish a full cycle.
	if (String(nextCursor) === '0') {
		nextPatternIndex = (state.patternIndex + 1) % PATTERNS.length;
		nextCursor = '0';
		if (nextPatternIndex === 0) {
			doneCycle = true;
			cycle += 1;
		}
	}

	const nextState: ReverseIndexState = {
		cursor: String(nextCursor),
		patternIndex: nextPatternIndex,
		processedIndividuals: state.processedIndividuals + individualsProcessed,
		firmsWritten: state.firmsWritten + firmsWritten,
		firmsSkippedUnchanged: state.firmsSkippedUnchanged + firmsSkippedUnchanged,
		updatedAt: new Date().toISOString(),
		cycle,
	};

	if (updateCrdLog && crdLogEntries.length) {
		await rememberCrdLogEntries(crdLogEntries);
	}

	return {
		ok: true,
		redisOnly: true,
		pattern,
		cursorStart,
		cursorEnd: nextState.cursor,
		keysScanned: page.keys.length,
		individualsProcessed,
		individualsWithEmployment,
		firmsWritten,
		firmsSkippedUnchanged,
		doneCycle,
		state: nextState,
	};
}
