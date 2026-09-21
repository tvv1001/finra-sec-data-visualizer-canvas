import { NextRequest, NextResponse } from 'next/server';
import { Redis as UpstashRedis } from '@upstash/redis';

const QUEUE_KEY = 'finra:cron:queue';
const RETRY_ZSET = 'finra:cron:retry';
const PROCESSED_SET = 'finra:cron:processed';
const MONITOR_KEY = 'finra:redis-monitor';
const PENDING_PREFIX = 'finra:pending';

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
	if (!isAuthorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

	const upstash = getUpstashClient();
	if (!upstash) return NextResponse.json({ ok: false, error: 'upstash-not-configured' }, { status: 503 });

	try {
		const [queueLen, retryCount, processedCount, monitorEntries] = await Promise.all([
			(upstash as any).llen?.(QUEUE_KEY).catch(() => 0),
			(upstash as any).zcard?.(RETRY_ZSET).catch(() => 0),
			(upstash as any).scard?.(PROCESSED_SET).catch(() => 0),
			(upstash as any).lrange?.(MONITOR_KEY, 0, 9).catch(() => []),
		]);

		const queueSample = (Array.isArray(await (upstash as any).lrange?.(QUEUE_KEY, 0, 9)) ? await (upstash as any).lrange?.(QUEUE_KEY, 0, 9) : []) as string[];

		let retrySample: string[] = [];
		try {
			retrySample = Array.isArray(await (upstash as any).zrange?.(RETRY_ZSET, 0, 9)) ? await (upstash as any).zrange?.(RETRY_ZSET, 0, 9) : [];
		} catch {
			try {
				retrySample =
					Array.isArray(await (upstash as any).zrangebyscore?.(RETRY_ZSET, '-inf', '+inf', { LIMIT: [0, 10] })) ?
						await (upstash as any).zrangebyscore?.(RETRY_ZSET, '-inf', '+inf', { LIMIT: [0, 10] })
					:	[];
			} catch {
				retrySample = [];
			}
		}

		// try to list a few pending keys (best-effort)
		let pendingKeys: string[] = [];
		try {
			if ((upstash as any).keys) {
				const all = (await (upstash as any).keys?.(`${PENDING_PREFIX}:*`).catch(() => [])) as string[];
				if (Array.isArray(all) && all.length) pendingKeys = all.slice(0, 10);
			}
		} catch {
			pendingKeys = [];
		}

		const monitor =
			Array.isArray(monitorEntries) ?
				monitorEntries.map((r: string) => {
					try {
						return JSON.parse(r);
					} catch {
						return { raw: r };
					}
				})
			:	[];

		return NextResponse.json(
			{
				ok: true,
				counts: {
					queue: Number(queueLen) || 0,
					retry: Number(retryCount) || 0,
					processed: Number(processedCount) || 0,
				},
				samples: {
					queue: queueSample,
					retry: retrySample,
					pendingKeys,
					monitor,
				},
				ts: new Date().toISOString(),
			},
			{ headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
