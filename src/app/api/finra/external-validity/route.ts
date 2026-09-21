import { NextRequest, NextResponse } from 'next/server';
import { runExternalValidityCron } from '@/lib/externalValidityCron';
import { setExternalApiContext } from '@/lib/externalApiGate';

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

export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const previousContext = process.env.EXTERNAL_API_CONTEXT;
		setExternalApiContext('cronjob');
		try {
			const result = await runExternalValidityCron();
			return NextResponse.json(result, {
				headers: {
					'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
				},
			});
		} finally {
			setExternalApiContext(previousContext || null);
		}
	} catch (error: any) {
		return NextResponse.json(
			{ ok: false, error: String(error?.message || error) },
			{ status: 500, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	}
}
