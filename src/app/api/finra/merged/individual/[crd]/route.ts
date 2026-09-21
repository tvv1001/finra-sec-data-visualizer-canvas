import { NextRequest, NextResponse } from 'next/server';
import { GET as getIndividual } from '@/app/api/finra/individual/[crd]/route';

export async function GET(request: NextRequest, { params }: { params: Promise<{ crd: string }> }) {
	const { crd } = await params;
	if (!/^[0-9]+$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD' }, { status: 400 });
	}
	const mergedUrl = new URL(request.url);
	mergedUrl.searchParams.set('merged', '1');
	mergedUrl.searchParams.set('includePrevious', 'true');
	const mergedRequest = new NextRequest(mergedUrl, { headers: request.headers });
	return getIndividual(mergedRequest, { params: Promise.resolve({ crd }) });
}
