import { Worker } from 'node:worker_threads';
import path from 'node:path';

let worker: Worker | null = null;
let counter = 0;
const pending = new Map<number, (v: any) => void>();

function ensureWorker() {
	if (worker) return worker;
	const workerPath = path.join(__dirname, 'gzip-worker.js');
	worker = new Worker(workerPath);
	worker.on('message', (msg: any) => {
		const id = msg?.id;
		const cb = pending.get(id);
		if (cb) {
			pending.delete(id);
			cb(msg);
		}
	});
	worker.on('error', (err) => {
		// Clear pending with error
		for (const [id, cb] of Array.from(pending.entries())) {
			pending.delete(id);
			cb({ ok: false, error: String(err) });
		}
	});
	worker.on('exit', () => {
		worker = null;
	});
	return worker;
}

export async function gzipOffload(input: Buffer | string): Promise<string> {
	try {
		const w = ensureWorker();
		const id = ++counter;
		const payload = typeof input === 'string' ? input : input.toString('utf-8');
		return await new Promise((resolve, reject) => {
			pending.set(id, (msg: any) => {
				if (msg && msg.ok) resolve(msg.result);
				else reject(new Error(msg?.error || 'gzip worker failed'));
			});
			w.postMessage({ id, action: 'gzip', payload });
		});
	} catch (e) {
		throw e;
	}
}

export async function gunzipOffload(b64: string): Promise<string> {
	try {
		const w = ensureWorker();
		const id = ++counter;
		return await new Promise((resolve, reject) => {
			pending.set(id, (msg: any) => {
				if (msg && msg.ok) resolve(msg.result);
				else reject(new Error(msg?.error || 'gunzip worker failed'));
			});
			w.postMessage({ id, action: 'gunzip', payload: b64 });
		});
	} catch (e) {
		throw e;
	}
}

export function terminateGzipWorker() {
	if (worker) {
		try {
			worker.terminate();
		} catch {}
		worker = null;
	}
}
