import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/simpleCache';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FINRA_FDA_SEARCH_URL = 'https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions-online';
const FDA_CACHE_TTL_SECONDS = 60 * 60;

type FinraFdaLink = {
	label: string;
	href: string;
};

type FinraFdaLookupResult = {
	docket: string;
	found: boolean;
	blocked: boolean;
	noResults: boolean;
	upstreamStatus: number;
	title: string | null;
	resultUrl: string | null;
	links: FinraFdaLink[];
	bodyText: string;
	meta: {
		searchUrl: string;
		searchedDocket: string;
		searchPageStatus: number;
		lookupPageStatus: number;
		blockedReason: string | null;
	};
};

function normalizeDocket(raw: string) {
	return String(raw || '')
		.trim()
		.replace(/\s+/g, ' ');
}

function isValidDocket(docket: string) {
	return docket.length > 0 && docket.length <= 120 && /^[A-Za-z0-9./_\- ]+$/.test(docket);
}

function extractCookieHeader(setCookie: string | string[] | undefined) {
	if (!setCookie) return '';
	const values = Array.isArray(setCookie) ? setCookie : [setCookie];
	return values
		.flatMap((value) => String(value).split(/,(?=\s*[A-Za-z0-9_]+=)/g))
		.map((value) => value.split(';')[0].trim())
		.filter(Boolean)
		.join('; ');
}

function extractInputValue(html: string, name: string) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = html.match(new RegExp(`<input[^>]+name=["']${escaped}["'][^>]+value=["']([^"']*)["']`, 'i'));
	return match ? match[1] : '';
}

function extractHtmlTitle(html: string) {
	const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	return match ? decodeHtmlEntities(match[1]).trim() : null;
}

function decodeHtmlEntities(value: string) {
	return String(value || '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#(\d+);/g, (_match, code) => {
			const numeric = Number(code);
			return Number.isFinite(numeric) ? String.fromCharCode(numeric) : _match;
		});
}

function stripHtml(html: string) {
	return decodeHtmlEntities(
		String(html || '')
			.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
			.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<\/li>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\r/g, '')
			.replace(/\t/g, ' ')
			.replace(/[ ]{2,}/g, ' ')
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
	);
}

function isBlockedHtml(status: number, html: string) {
	if (status >= 500) return true;
	return /503 Service Temporarily Unavailable|__CF\$cv\$params|challenge-platform|cloudflare/i.test(html);
}

function hasNoResults(html: string) {
	return /no results found|did not match any records|no disciplinary actions found|there are no results/i.test(html);
}

function toAbsoluteFinraUrl(href: string) {
	try {
		return new URL(href, 'https://www.finra.org').toString();
	} catch {
		return href;
	}
}

function inferLinkLabel(href: string) {
	if (/\.pdf(?:$|[?#])/i.test(href)) return 'FINRA PDF';
	if (/disciplinary-actions/i.test(href)) return 'FINRA disciplinary action';
	return 'FINRA result';
}

function extractResultLinks(html: string) {
	const links = new Map<string, FinraFdaLink>();
	const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(html)) !== null) {
		const href = toAbsoluteFinraUrl(match[1]);
		if (!href.startsWith('https://www.finra.org/')) continue;
		if (href === FINRA_FDA_SEARCH_URL) continue;
		if (/important-notes|site-map|privacy-policy|contact-finra|brokercheck/i.test(href)) continue;
		if (!/oversight-enforcement|disciplinary-actions|\/sites\/default\/files\//i.test(href)) continue;
		if (!links.has(href)) {
			const labelText = stripHtml(match[2]).trim();
			links.set(href, {
				label: labelText || inferLinkLabel(href),
				href,
			});
		}
	}

	return Array.from(links.values()).slice(0, 8);
}

function extractMeaningfulText(html: string, docket: string) {
	const articleMatch = html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<body\b[\s\S]*?<\/body>/i);
	const source = articleMatch ? articleMatch[0] : html;
	const text = stripHtml(source);
	if (!text) return '';
	const docketIndex = docket ? text.toLowerCase().indexOf(docket.toLowerCase()) : -1;
	if (docketIndex >= 0) {
		const start = Math.max(0, docketIndex - 500);
		const end = Math.min(text.length, docketIndex + 3500);
		return text.slice(start, end).trim();
	}
	return text.slice(0, 4000).trim();
}

async function lookupFinraFdaDocket(docket: string): Promise<FinraFdaLookupResult> {
	return cachedFetch(`finra:fda:${docket}`, FDA_CACHE_TTL_SECONDS, async () => {
		const { default: axios } = await import('axios');
		const browserLikeHeaders = {
			...DEFAULT_HEADERS,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		};

		const searchPageResponse = await axios.get<string>(FINRA_FDA_SEARCH_URL, {
			headers: browserLikeHeaders,
			timeout: 20000,
			responseType: 'text',
			validateStatus: () => true,
		});

		const searchPageHtml = String(searchPageResponse.data || '');
		const formBuildId = extractInputValue(searchPageHtml, 'form_build_id');
		const formId = extractInputValue(searchPageHtml, 'form_id');
		const cookieHeader = extractCookieHeader(searchPageResponse.headers['set-cookie']);

		if (!formBuildId || !formId) {
			return {
				docket,
				found: false,
				blocked: false,
				noResults: false,
				upstreamStatus: searchPageResponse.status,
				title: extractHtmlTitle(searchPageHtml),
				resultUrl: null,
				links: [],
				bodyText: `FINRA disciplinary actions lookup for docket \"${docket}\" is currently unavailable because the upstream search form could not be initialized.`,
				meta: {
					searchUrl: FINRA_FDA_SEARCH_URL,
					searchedDocket: docket,
					searchPageStatus: searchPageResponse.status,
					lookupPageStatus: 0,
					blockedReason: null,
				},
			};
		}

		const body = new URLSearchParams({
			fda_search: docket,
			firms: '',
			individuals: '',
			from_date: '',
			to_date: '',
			document_type: 'All',
			case_id: docket,
			terms_of_service: '1',
			op: 'Submit',
			form_build_id: formBuildId,
			form_id: formId,
		});

		const lookupResponse = await axios.post<string>(FINRA_FDA_SEARCH_URL, body.toString(), {
			headers: {
				...browserLikeHeaders,
				'Content-Type': 'application/x-www-form-urlencoded',
				'Origin': 'https://www.finra.org',
				'Referer': FINRA_FDA_SEARCH_URL,
				...(cookieHeader ? { Cookie: cookieHeader } : {}),
			},
			timeout: 20000,
			responseType: 'text',
			validateStatus: () => true,
			maxRedirects: 5,
		});

		const lookupHtml = String(lookupResponse.data || '');
		const blocked = isBlockedHtml(lookupResponse.status, lookupHtml);
		const noResults = !blocked && hasNoResults(lookupHtml);
		const links = blocked ? [] : extractResultLinks(lookupHtml);
		const resultUrl = links[0]?.href || null;

		let resultPageStatus = 0;
		let title = extractHtmlTitle(lookupHtml);
		let text = blocked ? '' : extractMeaningfulText(lookupHtml, docket);

		if (!blocked && resultUrl) {
			const resultResponse = await axios.get<string>(resultUrl, {
				headers: {
					...browserLikeHeaders,
					Referer: FINRA_FDA_SEARCH_URL,
					...(cookieHeader ? { Cookie: cookieHeader } : {}),
				},
				timeout: 20000,
				responseType: 'text',
				validateStatus: () => true,
			});
			resultPageStatus = resultResponse.status;
			const resultHtml = String(resultResponse.data || '');
			if (!isBlockedHtml(resultPageStatus, resultHtml)) {
				title = extractHtmlTitle(resultHtml) || title;
				text = extractMeaningfulText(resultHtml, docket) || text;
			}
		}

		const found = !blocked && !noResults && (Boolean(resultUrl) || Boolean(text));
		const blockedReason = blocked ? `FINRA upstream returned HTTP ${lookupResponse.status} and presented an anti-bot or temporary-unavailable response.` : null;

		const bodyText =
			blocked ?
				`FINRA disciplinary actions lookup for docket \"${docket}\" is temporarily unavailable because the upstream site returned HTTP ${lookupResponse.status}. Please try again later.`
			: noResults ? `No published FINRA disciplinary action matched docket \"${docket}\".`
			: text || `A FINRA disciplinary action lookup completed for docket \"${docket}\", but the response did not include extractable body text.`;

		return {
			docket,
			found,
			blocked,
			noResults,
			upstreamStatus: lookupResponse.status,
			title,
			resultUrl,
			links,
			bodyText,
			meta: {
				searchUrl: FINRA_FDA_SEARCH_URL,
				searchedDocket: docket,
				searchPageStatus: searchPageResponse.status,
				lookupPageStatus: resultPageStatus,
				blockedReason,
			},
		};
	});
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ docket: string }> }) {
	const rawDocket = (await params).docket;
	const docket = normalizeDocket(rawDocket);

	if (!isValidDocket(docket)) {
		return NextResponse.json({ error: 'Invalid docket number.' }, { status: 400 });
	}

	try {
		const result = await lookupFinraFdaDocket(docket);
		
		if (!result) {
			throw new Error(`FDA lookup returned undefined for docket ${docket}`);
		}

		return NextResponse.json(
			{
				docket: result.docket,
				found: result.found,
				blocked: result.blocked,
				noResults: result.noResults,
				upstreamStatus: result.upstreamStatus,
				title: result.title,
				resultUrl: result.resultUrl,
				links: result.links,
				node: {
					data: {
						attributes: {
							body: { value: result.bodyText },
							field_body: { value: result.bodyText },
							field_fda_body: { value: result.bodyText },
						},
					},
				},
				meta: result.meta,
			},
			{ headers: sharedCacheHeaders(FDA_CACHE_TTL_SECONDS) },
		);
	} catch (error: any) {
		logger.error('finra fda proxy error', {
			docket,
			error: error?.message || String(error),
		});
		const bodyText = `FINRA disciplinary actions lookup for docket "${docket}" is temporarily unavailable because the upstream request failed. Please try again later.`;
		return NextResponse.json(
			{
				docket,
				found: false,
				blocked: true,
				noResults: false,
				upstreamStatus: 502,
				title: 'FINRA disciplinary action lookup unavailable',
				resultUrl: null,
				links: [],
				node: {
					data: {
						attributes: {
							body: { value: bodyText },
							field_body: { value: bodyText },
							field_fda_body: { value: bodyText },
						},
					},
				},
				meta: {
					searchUrl: FINRA_FDA_SEARCH_URL,
					searchedDocket: docket,
					searchPageStatus: 0,
					lookupPageStatus: 0,
					blockedReason: error?.message || String(error),
				},
			},
			{ headers: sharedCacheHeaders(FDA_CACHE_TTL_SECONDS) },
		);
	}
}
