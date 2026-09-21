import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/lib/logger';

/**
 * Performance analytics — local file only (no Redis).
 * Path: data/logs/perf.log (JSONL). Avoids Upstash read/write quota burn.
 */
const PERF_LOG_RELATIVE = path.join('data', 'logs', 'perf.log');
/** Legacy filename — read as fallback so existing local history is not lost. */
const PERF_LOG_LEGACY_RELATIVE = path.join('data', 'logs', 'performance.jsonl');

export type PerformanceLogEntry = {
	label: string;
	durationMs?: number;
	memoryUsedMb?: number;
	heapUsedMb?: number;
	rssMb?: number;
	status?: 'ok' | 'error';
	meta?: Record<string, unknown>;
	phase?: 'start' | 'end';
	at: string;
};

function getMemorySnapshot() {
	if (typeof process === 'undefined' || !process.memoryUsage) {
		return null;
	}
	const usage = process.memoryUsage();
	return {
		heapUsedMb: Number((usage.heapUsed / 1024 / 1024).toFixed(2)),
		rssMb: Number((usage.rss / 1024 / 1024).toFixed(2)),
	};
}

function getPerformanceLogPath() {
	if (typeof process === 'undefined' || !process.cwd) return null;
	return path.join(process.cwd(), PERF_LOG_RELATIVE);
}

function getLegacyPerformanceLogPath() {
	if (typeof process === 'undefined' || !process.cwd) return null;
	return path.join(process.cwd(), PERF_LOG_LEGACY_RELATIVE);
}

async function readJsonlFile(logPath: string, limit: number): Promise<PerformanceLogEntry[]> {
	try {
		const raw = await fs.readFile(logPath, 'utf8');
		const lines = raw
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(-limit);
		return lines
			.map((line) => {
				try {
					return JSON.parse(line) as PerformanceLogEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is PerformanceLogEntry => Boolean(entry));
	} catch {
		return [];
	}
}

async function readPerformanceLogEntriesFromFile(limit: number): Promise<PerformanceLogEntry[]> {
	const primary = getPerformanceLogPath();
	if (primary) {
		const fromPrimary = await readJsonlFile(primary, limit);
		if (fromPrimary.length > 0) return fromPrimary;
	}
	const legacy = getLegacyPerformanceLogPath();
	if (legacy) return readJsonlFile(legacy, limit);
	return [];
}

export async function readPerformanceLogEntries(limit = 250): Promise<PerformanceLogEntry[]> {
	return readPerformanceLogEntriesFromFile(limit);
}

export type PerformanceLogLabelSummary = {
	label: string;
	count: number;
	avgMs: number;
	p95Ms: number;
	maxMs: number;
	errors: number;
	peakHeapMb: number;
};

export type PerformanceLogSummary = {
	entryCount: number;
	firstAt: string | null;
	lastAt: string | null;
	byLabel: PerformanceLogLabelSummary[];
	memoryLeakRisk: boolean;
};

/** Mirrors scripts/perf-report.mjs so the same summary is available via API in prod. */
export function summarizePerformanceLogEntries(entries: PerformanceLogEntry[]): PerformanceLogSummary {
	if (entries.length === 0) {
		return { entryCount: 0, firstAt: null, lastAt: null, byLabel: [], memoryLeakRisk: false };
	}

	const byLabelMap = new Map<string, PerformanceLogEntry[]>();
	for (const entry of entries) {
		const label = String(entry.label || 'unknown');
		const bucket = byLabelMap.get(label) || [];
		bucket.push(entry);
		byLabelMap.set(label, bucket);
	}

	const byLabel: PerformanceLogLabelSummary[] = [...byLabelMap.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([label, items]) => {
			const durations = items.map((item) => Number(item.durationMs || 0)).filter((n) => Number.isFinite(n));
			const heapValues = items.map((item) => Number(item.heapUsedMb || 0)).filter((n) => Number.isFinite(n));
			const avgMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
			const maxMs = durations.length ? Math.max(...durations) : 0;
			const sorted = durations.slice().sort((a, b) => a - b);
			const p95Ms = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
			const peakHeapMb = heapValues.length ? Math.max(...heapValues) : 0;
			const errors = items.filter((item) => item.status === 'error').length;
			return {
				label,
				count: items.length,
				avgMs: Number(avgMs.toFixed(1)),
				p95Ms: Number(p95Ms.toFixed(1)),
				maxMs: Number(maxMs.toFixed(1)),
				errors,
				peakHeapMb: Number(peakHeapMb.toFixed(2)),
			};
		});

	const leakCandidates = entries
		.filter((item) => item.heapUsedMb != null && Number(item.heapUsedMb) > 0)
		.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

	let memoryLeakRisk = false;
	for (let i = 1; i < leakCandidates.length; i += 1) {
		const prev = Number(leakCandidates[i - 1].heapUsedMb || 0);
		const curr = Number(leakCandidates[i].heapUsedMb || 0);
		if (curr > prev + 20) {
			memoryLeakRisk = true;
			break;
		}
	}

	return {
		entryCount: entries.length,
		firstAt: entries[0]?.at ?? null,
		lastAt: entries[entries.length - 1]?.at ?? null,
		byLabel,
		memoryLeakRisk,
	};
}

export async function writePerformanceMetric(entry: Omit<PerformanceLogEntry, 'at'> & { at?: string }) {
	const logPath = getPerformanceLogPath();
	const memory = getMemorySnapshot();
	const payload: PerformanceLogEntry = {
		at: entry.at || new Date().toISOString(),
		label: entry.label,
		durationMs: entry.durationMs,
		memoryUsedMb: entry.memoryUsedMb ?? memory?.heapUsedMb,
		heapUsedMb: entry.heapUsedMb ?? memory?.heapUsedMb,
		rssMb: entry.rssMb ?? memory?.rssMb,
		status: entry.status,
		phase: entry.phase,
		meta: entry.meta,
	};

	if (logPath) {
		try {
			await fs.mkdir(path.dirname(logPath), { recursive: true });
			await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
		} catch (error) {
			// Expected on serverless/read-only filesystems — no Redis fallback (quota).
			logger.debug('performance analytics file write skipped', {
				label: payload.label,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	logger.info('performance', payload);
}

export async function measurePerformance<T>(label: string, work: () => Promise<T> | T, meta: Record<string, unknown> = {}): Promise<T> {
	const startedAt = Date.now();
	const memoryBefore = getMemorySnapshot();
	try {
		const result = await work();
		const durationMs = Date.now() - startedAt;
		const memoryAfter = getMemorySnapshot();
		await writePerformanceMetric({
			label,
			durationMs,
			memoryUsedMb: memoryAfter?.heapUsedMb,
			heapUsedMb: memoryAfter?.heapUsedMb,
			rssMb: memoryAfter?.rssMb,
			status: 'ok',
			phase: 'end',
			meta: {
				...meta,
				memoryBeforeMb: memoryBefore?.heapUsedMb,
				memoryDeltaMb: memoryAfter && memoryBefore ? Number((memoryAfter.heapUsedMb - memoryBefore.heapUsedMb).toFixed(2)) : undefined,
			},
		});
		return result;
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const memoryAfter = getMemorySnapshot();
		await writePerformanceMetric({
			label,
			durationMs,
			memoryUsedMb: memoryAfter?.heapUsedMb,
			heapUsedMb: memoryAfter?.heapUsedMb,
			rssMb: memoryAfter?.rssMb,
			status: 'error',
			phase: 'end',
			meta: {
				...meta,
				error: error instanceof Error ? error.message : String(error),
				memoryBeforeMb: memoryBefore?.heapUsedMb,
				memoryDeltaMb: memoryAfter && memoryBefore ? Number((memoryAfter.heapUsedMb - memoryBefore.heapUsedMb).toFixed(2)) : undefined,
			},
		});
		throw error;
	}
}
