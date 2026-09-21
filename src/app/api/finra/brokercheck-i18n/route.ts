import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/simpleCache';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const lang = searchParams.get('lang') || 'en';
		if (!/^[a-z]{2}$/i.test(lang)) {
			return NextResponse.json({ error: 'Invalid language code.' }, { status: 400 });
		}

		const normalizedLang = lang.toLowerCase();
		const url = `https://brokercheck.finra.org/assets/i18n/${encodeURIComponent(normalizedLang)}.json`;
		const cacheKey = `finra:brokercheck:i18n:${normalizedLang}`;

		const data = await cachedFetch(cacheKey, 60 * 60, async () => {
			const { default: axios } = await import('axios');
			const response = await axios.get(url, {
				headers: DEFAULT_HEADERS,
				timeout: 15000,
			});
			return response.data;
		});

		return NextResponse.json(data);
	} catch (err: any) {
		logger.error('brokercheck-i18n proxy error', { error: err.message });
		return NextResponse.json({ error: 'Failed to fetch BrokerCheck i18n asset.' }, { status: 502 });
	}
}
