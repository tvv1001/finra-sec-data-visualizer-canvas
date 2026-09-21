import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

// prefer MIRROR env var but fall back to legacy _2 names
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN || null;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const CACHE_DIR = path.join(process.cwd(), 'data', 'national', 'api_cache');

async function upstashDel(key: string) {
	if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
	try {
		const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
		});
		return res.ok;
	} catch (e) {
		return false;
	}
}

export async function POST(req: NextRequest) {
	const header = req.headers.get('x-admin-secret') || '';
	if (!ADMIN_SECRET || header !== ADMIN_SECRET) {
		return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
	}
	let body: any;
	try {
		body = await req.json();
	} catch (e) {
		return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
	}
	const keys: string[] = Array.isArray(body.keys) ? body.keys : [];
	if (!keys.length) return NextResponse.json({ ok: false, error: 'no-keys-provided' }, { status: 400 });

	const results: any[] = [];
	for (const key of keys) {
		const r: any = { key };
		// delete from Upstash
		if (UPSTASH_URL && UPSTASH_TOKEN) {
			r.upstash = await upstashDel(key);
			try {
				// also attempt to delete meta
				await upstashDel(key + ':meta');
			} catch (e) {}
		} else {
			r.upstash = null;
		}
		// delete local files
		try {
			const base = encodeURIComponent(key);
			const bin = path.join(CACHE_DIR, `${base}.bin`);
			const json = path.join(CACHE_DIR, `${base}.json`);
			const meta = path.join(CACHE_DIR, `${base}:meta.json`);
			const deleted: string[] = [];
			for (const p of [bin, json, meta]) {
				try {
					await fs.unlink(p);
					deleted.push(p);
				} catch (e) {}
			}
			r.localDeleted = deleted;
		} catch (e) {
			r.localDeleted = [];
		}
		results.push(r);
	}
	return NextResponse.json({ ok: true, results });
}

export async function GET() {
	return NextResponse.json({ ok: false, error: 'POST only' }, { status: 405 });
}
