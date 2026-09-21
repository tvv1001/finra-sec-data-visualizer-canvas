import { NextRequest, NextResponse } from 'next/server';
import { SCRAPER_PATH } from '@/lib/scraperPaths';
import { invalidateGraphCache } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const seeds = searchParams.get('seeds') || '';
	const profile = searchParams.get('profile') || '';

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (data: Record<string, unknown>) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			};

			try {
				const { spawn } = await import('node:child_process');
				const args = ['--max-old-space-size=512', SCRAPER_PATH];
				if (seeds) args.push('--seeds', seeds);
				if (profile) args.push('--profile', profile);

				send({ type: 'start', message: 'Scraper starting...' });

				const child = spawn(process.execPath, args, {
					env: { ...process.env },
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				child.stdout.on('data', (chunk: Buffer) => {
					const lines = chunk.toString().split('\n').filter(Boolean);
					for (const line of lines) {
						send({ type: 'log', message: line });
					}
				});
				child.stderr.on('data', (chunk: Buffer) => {
					const lines = chunk.toString().split('\n').filter(Boolean);
					for (const line of lines) {
						send({ type: 'log', message: line });
					}
				});

				await new Promise<void>((resolve, reject) => {
					child.on('close', (code: number | null) => {
						if (code === 0) resolve();
						else reject(new Error(`Scraper exited with code ${code}`));
					});
					child.on('error', reject);
				});

				invalidateGraphCache();
				send({ type: 'complete', message: 'Scraper finished.' });
			} catch (err: any) {
				logger.error('scraper error', { error: err.message });
				send({ type: 'error', message: err.message });
			} finally {
				controller.close();
			}
		},
	});

	return new NextResponse(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		},
	});
}
