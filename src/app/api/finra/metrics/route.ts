import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { Redis as UpstashRedis } from '@upstash/redis';

function getUpstashClient() {
	try {
		// prefer MIRROR env var but fall back to legacy _2 names
		const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
		const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
		if (url && token) return new UpstashRedis({ url, token });
	} catch (e) {
		// ignore
	}
	return null;
}

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	return request.headers.get('authorization') === `Bearer ${secret}`;
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	let upstash: any = null;
	try {
		upstash = getUpstashClient();
	} catch (e) {
		upstash = null;
	}

	if (!upstash) {
		return NextResponse.json({ ok: false, error: 'upstash-not-configured' }, { status: 503 });
	}

	try {
		const rawEntries: string[] = await upstash.lrange('finra:redis-monitor', 0, 199);
		const entries =
			Array.isArray(rawEntries) ?
				rawEntries.map((r) => {
					try {
						return JSON.parse(r);
					} catch (e) {
						return { raw: r };
					}
				})
			:	[];

		const counterKeys = {
			total_runs: 'finra:metrics:prime-check:total_runs',
			external_runs: 'finra:metrics:prime-check:external_runs',
			missing_processed: 'finra:metrics:prime-check:missing_processed',
			warmed_individuals: 'finra:metrics:prime-check:warmed_individuals',
			warmed_firms: 'finra:metrics:prime-check:warmed_firms',
			failures: 'finra:metrics:prime-check:failures',
		} as const;

		const vals = await Promise.all(Object.values(counterKeys).map((k) => upstash.get(String(k)).catch(() => null)));

		const counters: Record<string, number> = {};
		Object.keys(counterKeys).forEach((k, i) => {
			const raw = vals[i];
			const n = Number(raw || 0) || 0;
			counters[k] = n;
		});

		// Build a simple title from the most recent entry (after -> people/firms/links) if available
		let title = '';
		if (Array.isArray(entries) && entries.length > 0) {
			const recent = entries[0] as any;
			const stats = recent?.after || recent?.before || null;
			const people = stats?.people ?? null;
			const firms = stats?.firms ?? null;
			const links = stats?.links ?? null;
			if (people != null || firms != null || links != null) {
				const parts: string[] = [];
				if (people != null) parts.push(`people: ${people}`);
				if (firms != null) parts.push(`firms: ${firms}`);
				if (links != null) parts.push(`links: ${links}`);
				title = parts.join('  |  ');
			}
		}

		return NextResponse.json({ ok: true, title, monitor: entries, counters }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
	} catch (err: any) {
		logger.warn('metrics: failed to read upstash data', { error: String(err?.message || err) });
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
