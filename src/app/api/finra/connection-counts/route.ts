import { NextRequest, NextResponse } from 'next/server';
import { readFirmConnectionCountFromFlatfile } from '@/lib/localSearch';
import { sharedCacheHeaders } from '@/lib/httpCache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Lightweight current-connection counts for firm node sizing.
 * Query: ?ids=firm:103863,705,firm:7691
 */
export async function GET(request: NextRequest) {
	const raw = String(request.nextUrl.searchParams.get('ids') || '').trim();
	const ids = Array.from(
		new Set(
			raw
				.split(/[,\s]+/)
				.map((value) => String(value || '').replace(/^firm:/i, '').trim())
				.filter(Boolean),
		),
	).slice(0, 200);

	const counts: Record<string, number> = {};
	for (const firmId of ids) {
		const count = readFirmConnectionCountFromFlatfile(firmId);
		if (count > 0) {
			counts[firmId] = count;
			counts[`firm:${firmId}`] = count;
		}
	}

	return NextResponse.json({ counts }, { headers: sharedCacheHeaders(120) });
}
