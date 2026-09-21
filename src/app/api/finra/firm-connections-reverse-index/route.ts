import { NextRequest, NextResponse } from 'next/server';
import { runFirmConnectionsReverseIndexPass } from '@/lib/firmConnectionsReverseIndex';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const auth = request.headers.get('authorization');
	if (auth === `Bearer ${secret}`) return true;
	return request.headers.get('x-vercel-cron') === '1';
}

/**
 * Rare Redis-cache-only reverse index pass (no external FINRA/SEC calls).
 * Advances a durable SCAN cursor and upserts person→employer firm-connections
 * only when membership changed.
 */
export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const url = new URL(request.url);
		const batchSize = Number(url.searchParams.get('batchSize') || 25);
		const maxFirmWrites = Number(url.searchParams.get('maxFirmWrites') || 40);
		const scanCount = Number(url.searchParams.get('scanCount') || Math.max(64, batchSize));
		const resetCursor = url.searchParams.get('reset') === '1';

		const result = await runFirmConnectionsReverseIndexPass({
			batchSize,
			maxFirmWrites,
			scanCount,
			resetCursor,
			updateCrdLog: true,
		});

		return NextResponse.json(result, {
			headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
		});
	} catch (error: any) {
		return NextResponse.json(
			{ ok: false, error: String(error?.message || error) },
			{ status: 500, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	}
}
