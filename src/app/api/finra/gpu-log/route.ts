import { NextRequest, NextResponse } from 'next/server';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const LOG_DIR = path.join(process.cwd(), '.local', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'client-memory.ndjson');

export async function POST(request: NextRequest) {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') {
			return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
		}
		const entry = {
			ts: new Date().toISOString(),
			...body,
		};
		await mkdir(LOG_DIR, { recursive: true });
		await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
		const usedMb = Number((body as any)?.jsHeapUsedMb);
		if (Number.isFinite(usedMb) && usedMb >= 1500) {
			console.warn(`[client-memory] jsHeapUsedMb=${usedMb} path=${(body as any)?.path || '?'}`);
		}
		return NextResponse.json({ ok: true });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
