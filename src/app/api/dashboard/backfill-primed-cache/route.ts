import { NextRequest, NextResponse } from 'next/server';
import { backfillPrimedCacheToRedis, createPrimedBackfillRedisClient } from '@/lib/primedRedisSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type BackfillPrimedCacheBody = {
	bundleNames?: string[] | string;
	maxRecords?: number;
	cursor?: number;
	overwrite?: boolean;
	dryRun?: boolean;
	ttlSeconds?: number;
};

export async function POST(request: NextRequest) {
	let body: BackfillPrimedCacheBody;
	try {
		body = (await request.json()) as BackfillPrimedCacheBody;
	} catch {
		return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
	}

	const redis = createPrimedBackfillRedisClient();
	if (!redis) {
		return NextResponse.json({ ok: false, error: 'missing-upstash-config', message: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.' }, { status: 500 });
	}

	try {
		const result = await backfillPrimedCacheToRedis(
			{
				bundleNames: body.bundleNames,
				maxRecords: body.maxRecords,
				cursor: body.cursor,
				overwrite: body.overwrite,
				dryRun: body.dryRun,
				ttlSeconds: body.ttlSeconds,
			},
			{ redis },
		);

		return NextResponse.json({
			ok: true,
			action: 'backfill-primed-cache',
			...result,
			at: new Date().toISOString(),
		});
	} catch (error: any) {
		return NextResponse.json(
			{
				ok: false,
				error: error?.message || String(error),
				at: new Date().toISOString(),
			},
			{ status: 500 },
		);
	}
}
