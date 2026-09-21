/* eslint-disable @typescript-eslint/no-require-imports */
const { parentPort } = require('worker_threads');
const { brotliCompress, brotliDecompress } = require('zlib');

function compressAsync(buf) {
	return new Promise((resolve, reject) => brotliCompress(buf, { params: { [require('zlib').constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, res) => (err ? reject(err) : resolve(res))));
}

function decompressAsync(buf) {
	return new Promise((resolve, reject) => brotliDecompress(buf, (err, res) => (err ? reject(err) : resolve(res))));
}

parentPort.on('message', async (msg) => {
	const { id, action, payload } = msg || {};
	try {
		if (action === 'gzip') {
			const buf = Buffer.from(payload, 'utf-8');
			const b = await compressAsync(buf);
			parentPort.postMessage({ id, ok: true, result: 'br:' + b.toString('base64') });
		} else if (action === 'gunzip') {
			let b64 = payload;
			if (typeof payload === 'string' && payload.startsWith('br:')) {
				b64 = payload.slice(3);
			}
			const buf = Buffer.from(b64, 'base64');
			const out = await decompressAsync(buf);
			parentPort.postMessage({ id, ok: true, result: out.toString('utf-8') });
		} else {
			parentPort.postMessage({ id, ok: false, error: 'unknown action' });
		}
	} catch (e) {
		parentPort.postMessage({ id, ok: false, error: String(e) });
	}
});
