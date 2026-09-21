import { NextRequest, NextResponse } from 'next/server';

// Server-only list of public IPs that should be excluded from analytics tracking
// (e.g. the developer's home/office machine). Never expose this via NEXT_PUBLIC_*
// so the IP list is not shipped to the client bundle.
const EXCLUDED_IPS = (process.env.ANALYTICS_EXCLUDED_IPS || '')
	.split(',')
	.map((ip) => ip.trim())
	.filter(Boolean);

function getClientIp(request: NextRequest): string | null {
	// Vercel populates x-forwarded-for with the real client IP first in the list.
	const forwardedFor = request.headers.get('x-forwarded-for');
	if (forwardedFor) {
		const first = forwardedFor.split(',')[0]?.trim();
		if (first) return first;
	}
	const realIp = request.headers.get('x-real-ip');
	if (realIp) return realIp.trim();
	return null;
}

export async function GET(request: NextRequest) {
	if (EXCLUDED_IPS.length === 0) {
		return NextResponse.json({ excluded: false });
	}

	const ip = getClientIp(request);
	const excluded = !!ip && EXCLUDED_IPS.includes(ip);

	return NextResponse.json({ excluded }, {
		headers: {
			'Cache-Control': 'no-store',
		},
	});
}
