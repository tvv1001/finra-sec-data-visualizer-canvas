import { NextResponse } from 'next/server';
import { clearGraphStore } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
	try {
		await clearGraphStore();
		return NextResponse.json(
			{
				ok: true,
				cleared: true,
				clearedAt: new Date().toISOString(),
			},
			{
				headers: {
					'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
				},
			},
		);
	} catch (error: any) {
		logger.error('graph-reset error', { error: error?.message || String(error) });
		return NextResponse.json(
			{ ok: false, error: 'Failed to clear persisted graph.' },
			{
				status: 500,
				headers: {
					'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
				},
			},
		);
	}
}
