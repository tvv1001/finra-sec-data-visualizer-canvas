import { NextRequest, NextResponse } from 'next/server';
import { readPerformanceLogEntries, summarizePerformanceLogEntries } from '@/lib/performanceLogger';

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

	const limitParam = Number(request.nextUrl.searchParams.get('limit') || 250);
	const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 250;

	try {
		const entries = await readPerformanceLogEntries(limit);
		const summary = summarizePerformanceLogEntries(entries);
		return NextResponse.json(
			{ ok: true, summary, entries },
			{ headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
