import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph } from '@/lib/graphStore';
import { logger } from '@/lib/logger';
import { isValidLocationStateFilter, nodeMatchesLocationSearch, normalizeLocationStateFilter, collectNodeLocationRecords } from '@/lib/locationSearch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const location = (searchParams.get('location') || searchParams.get('q') || '').trim();
		const rawState = (searchParams.get('state') || '').trim();
		const type = (searchParams.get('type') || 'all').trim();
		const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 200);

		const radiusStr = searchParams.get('radius');
		const radius = radiusStr && radiusStr !== 'any' ? parseFloat(radiusStr) : undefined;

		if (!location && !rawState && radius === undefined) {
			return NextResponse.json({ nodes: [], links: [], matchedIds: [], totalMatches: 0 });
		}
		if (rawState && !isValidLocationStateFilter(rawState)) {
			return NextResponse.json({ error: 'State must be a valid two-letter US code or INT.' }, { status: 400 });
		}

		const stateFilter = normalizeLocationStateFilter(rawState);
		const graph = await getFullGraph();
		const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
		const links: any[] = Array.isArray(graph?.links) ? graph.links : [];

		let refLat: number | undefined;
		let refLon: number | undefined;

		const paramLat = searchParams.get('lat') || searchParams.get('latitude');
		const paramLon = searchParams.get('lon') || searchParams.get('longitude') || searchParams.get('lng');
		if (paramLat && paramLon) {
			refLat = parseFloat(paramLat);
			refLon = parseFloat(paramLon);
		} else if (radius !== undefined && location) {
			const queryTerms = location
				.toLowerCase()
				.split(/[\s,]+/)
				.filter(Boolean);
			if (queryTerms.length > 0) {
				for (const node of nodes) {
					const records = collectNodeLocationRecords(node);
					const matchingRecord = records.find((rec) => {
						if (rec.latitude === undefined || rec.longitude === undefined) return false;
						const recordFullText = [rec.text, rec.city, rec.state, rec.postalCode, rec.country].filter(Boolean).join(' ').toLowerCase();
						return queryTerms.every((term) => recordFullText.includes(term));
					});
					if (matchingRecord) {
						refLat = matchingRecord.latitude;
						refLon = matchingRecord.longitude;
						break;
					}
				}
			}
		}

		const matchedNodes = nodes.filter((node) => {
			if (type !== 'all' && node?.group !== type) return false;
			return nodeMatchesLocationSearch(node, {
				locationQuery: location,
				stateFilter,
				radius,
				refLat,
				refLon,
			});
		});
		const limitedNodes = matchedNodes.slice(0, limit);
		const matchedIds = new Set(limitedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

		const matchedLinks = links.filter((link) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			return matchedIds.has(sourceId) || matchedIds.has(targetId);
		});

		const includedNodeIds = new Set<string>(matchedIds);
		matchedLinks.forEach((link) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId) includedNodeIds.add(sourceId);
			if (targetId) includedNodeIds.add(targetId);
		});

		return NextResponse.json({
			nodes: nodes.filter((node) => includedNodeIds.has(String(node?.id || '').trim())),
			links: matchedLinks,
			matchedIds: Array.from(matchedIds),
			totalMatches: matchedNodes.length,
		});
	} catch (err: any) {
		logger.error('location-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to perform location search.' }, { status: 500 });
	}
}
