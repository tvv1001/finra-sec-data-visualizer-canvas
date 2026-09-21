import { NextRequest, NextResponse } from 'next/server';
import { GET as getFirm } from '@/app/api/finra/firm/[id]/route';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[0-9]+$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm id' }, { status: 400 });
	}
	const mergedUrl = new URL(request.url);
	mergedUrl.searchParams.set('merged', '1');
	const mergedRequest = new NextRequest(mergedUrl, { headers: request.headers });
	return getFirm(mergedRequest, { params: Promise.resolve({ id }) });
}
