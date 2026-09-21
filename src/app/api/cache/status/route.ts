import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'fs/promises';
import { isRedisCacheOnly, getRedisUnusableReason } from '@/lib/redisAvailability';

const GRAPH_PATH = path.join(process.cwd(), 'data', 'national', 'finra-graph.json');
const OUT_DIR = path.join(process.cwd(), 'data', 'national');
// prefer MIRROR env var but fall back to legacy _2 names
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN || null;

async function checkUpstashKey(key: string) {
	if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
	try {
		const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
		});
		if (!res.ok) return null;
		const j = await res.json();
		return j && Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : null;
	} catch (e) {
		return null;
	}
}

export async function GET() {
	// This endpoint inspects the optional local data/national/finra-graph.json snapshot using a
	// legacy `cache:<type>::<id>` key scheme. That snapshot is not required for the app's primary
	// finra:/sec: Redis keyspace (used by the dashboard and graph), so its absence in a serverless
	// deployment (where data/national is typically not bundled) must not fail this endpoint.
	const redisConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
	const cacheOnly = isRedisCacheOnly();
	const architecture = {
		mode: cacheOnly ? ('cache-only' as const) : redisConfigured ? ('redis' as const) : ('disk-fallback' as const),
		redisConfigured,
		cacheOnly,
		cacheOnlyReason: cacheOnly ? getRedisUnusableReason() || null : null,
		note: "Reads the optional data/national graph snapshot's legacy cache:<type>::<id> keys; independent of the app's primary finra:/sec: Redis keyspace.",
	};

	let graph: any = null;
	try {
		const graphRaw = await fs.readFile(GRAPH_PATH, 'utf8');
		graph = JSON.parse(graphRaw);
	} catch (e) {
		// Optional local graph snapshot is absent (expected in serverless/cache-only environments)
		// or unreadable/corrupt — report an empty, healthy result instead of a 500.
		return NextResponse.json({ ok: true, count: 0, items: [], graphAvailable: false, architecture });
	}

	try {
		const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
		const items = [];
		for (const n of nodes) {
			const firmId = n.firmId || (n.id && String(n.id).replace(/^firm[:_]/, ''));
			const individualId =
				(n.basicInformation && (n.basicInformation.individualId || n.basicInformation.crd)) || n.individualId || (n.id && String(n.id).replace(/^person[:_]/, ''));
			if (firmId && (n.hasFinraPage || n.bcScope || n.hasFinraData)) {
				items.push({ type: 'finra-firm', id: firmId, nodeId: n.id });
			}
			if (individualId && (n.hasFinraPage || n.hasFinraData)) {
				items.push({ type: 'finra-person', id: individualId, nodeId: n.id });
			}
			if (firmId && (n.hasSecPage || n.hasSecData)) {
				items.push({ type: 'sec-firm', id: firmId, nodeId: n.id });
			}
			if (individualId && (n.hasSecPage || n.hasSecData)) {
				items.push({ type: 'sec-person', id: individualId, nodeId: n.id });
			}
		}

		const results = [];
		for (const it of items) {
			const key = `cache:${it.type}::${it.id}`;
			const parsedKey = `cache:parsed:${it.type}::${it.id}`;
			let raw = null;
			let parsed = null;
			let rawStat = null;
			let parsedStat = null;
			let rawIsBinary = false;
			let rawPreview = null;
			// check Upstash first (raw + meta, parsed)
			if (UPSTASH_URL && UPSTASH_TOKEN) {
				const meta = await checkUpstashKey(key + ':meta');
				if (meta && typeof meta === 'string') {
					try {
						const jm = JSON.parse(meta);
						if (jm && jm.binary) rawIsBinary = true;
					} catch (e) {}
				}
				raw = await checkUpstashKey(key);
				parsed = await checkUpstashKey(parsedKey);
			}
			// fallback to local files
			const cacheDir = path.join(OUT_DIR, 'api_cache');
			const rawBinFile = path.join(cacheDir, `${encodeURIComponent(key)}.bin`);
			const rawJsonFile = path.join(cacheDir, `${encodeURIComponent(key)}.json`);
			const parsedFile = path.join(cacheDir, `${encodeURIComponent(parsedKey)}.json`);
			// prefer binary local file
			try {
				const s = await fs.stat(rawBinFile);
				rawStat = { mtime: s.mtime.toISOString(), size: s.size };
				if (!raw) {
					const buf = await fs.readFile(rawBinFile);
					raw = buf.toString('base64');
					rawIsBinary = true;
				}
			} catch (e) {
				try {
					const s = await fs.stat(rawJsonFile);
					rawStat = { mtime: s.mtime.toISOString(), size: s.size };
					if (!raw) raw = await fs.readFile(rawJsonFile, 'utf8');
				} catch (e) {}
			}
			try {
				const s = await fs.stat(parsedFile);
				parsedStat = { mtime: s.mtime.toISOString(), size: s.size };
				if (!parsed) parsed = await fs.readFile(parsedFile, 'utf8');
			} catch (e) {}

			// prepare preview: if binary attempt to decode utf8; otherwise show start of text
			if (raw) {
				if (rawIsBinary) {
					// raw is base64; try to decode a utf8 preview
					try {
						const dec = Buffer.from(raw, 'base64').toString('utf8');
						rawPreview = dec.slice(0, 600);
					} catch (e) {
						rawPreview = raw.slice(0, 200); // base64 preview
					}
				} else {
					rawPreview = raw.slice(0, 600);
				}
			}

			results.push({
				type: it.type,
				id: it.id,
				nodeId: it.nodeId,
				rawCached: !!raw,
				rawIsBinary,
				rawPreview,
				rawStat,
				parsedCached: !!parsed,
				parsedPreview: parsed && parsed.slice ? parsed.slice(0, 600) : null,
				parsedStat,
			});
		}

		return NextResponse.json({ ok: true, count: results.length, items: results, graphAvailable: true, architecture });
	} catch (e: any) {
		return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
	}
}

export async function POST() {
	return new NextResponse('GET only', { status: 405 });
}
