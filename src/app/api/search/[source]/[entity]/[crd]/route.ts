import { NextRequest, NextResponse } from 'next/server';
import { sharedCacheHeaders } from '@/lib/httpCache';

export async function GET(request: NextRequest, { params }: { params: Promise<{ source: string; entity: string; crd: string }> }) {
	const { source, entity, crd } = await params;

	if (!/^[0-9]+$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD' }, { status: 400 });
	}

	if (entity !== 'individual' && entity !== 'firm') {
		return NextResponse.json({ error: 'Invalid entity' }, { status: 400 });
	}

	if (source !== 'finra' && source !== 'sec') {
		return NextResponse.json({ error: 'Invalid source' }, { status: 400 });
	}

	try {
		const apiUrl =
			source === 'finra' ? `https://api.brokercheck.finra.org/search/${entity}/${crd}?hl=true&wt=json` : `https://api.adviserinfo.sec.gov/search/${entity}/${crd}?wt=json`;

		const response = await fetch(apiUrl, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		});

		if (!response.ok) {
			return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
		}

		const searchResult = await response.json();
		const doc = searchResult?.response?.docs?.[0] ?? searchResult?.docs?.[0];

		if (!doc) {
			return NextResponse.json({ found: false }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
		}

		return NextResponse.json(
			{
				found: true,
				source,
				entity,
				crd,
				doc,
			},
			{ headers: sharedCacheHeaders(3600) },
		);
	} catch (err: any) {
		console.error(`Failed to fetch ${source} ${entity} ${crd}:`, err?.message);
		return NextResponse.json({ found: false, error: err?.message }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
	}
}
