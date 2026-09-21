Bundle storage and decoding

Manifests

- Each uploaded bundle has a manifest key in Redis: `<base>:manifest` (JSON).
- Manifest fields: { parts: <n>, bytes: <totalBytes>, method: 'json+gzip'|'msgpack+gzip', uploadedAt }
- Parts are stored as base64-encoded strings under keys: `<base>:part:0`, `<base>:part:1`, ...

Decoding (Node.js)

1. Fetch manifest and parts, assemble bytes, then decode according to `method`.

Example:

```js
const { Redis } = require('@upstash/redis');
const zlib = require('node:zlib');
const msgpack = require('msgpack-lite');

async function fetchBundle(redis, base) {
	const manifestRaw = await redis.get(`${base}:manifest`);
	if (!manifestRaw) throw new Error('manifest missing');
	const manifest = JSON.parse(manifestRaw);
	const parts = [];
	for (let i = 0; i < manifest.parts; i++) {
		const p = await redis.get(`${base}:part:${i}`);
		parts.push(Buffer.from(p, 'base64'));
	}
	const buf = Buffer.concat(parts);
	if (manifest.method === 'msgpack+gzip') {
		const out = zlib.gunzipSync(buf);
		return msgpack.decode(out);
	}
	if (manifest.method === 'json+gzip') {
		const out = zlib.gunzipSync(buf);
		return JSON.parse(out.toString('utf-8'));
	}
	// fallback: raw JSON
	return JSON.parse(buf.toString('utf-8'));
}
```

Notes

- Upstash request size limit (~10MB) requires chunking. We use 9MB chunks by default.
- Keep a small human-readable manifest in Redis so operations can atomically swap bundles by writing new parts then updating manifest.
- Prefer `msgpack+gzip` for size savings on large artifacts; keep per-CRD flat JSON keys for incremental updates.

People-first clustered primed cache

- `scripts/build_people_clusters.js` emits `people-cluster-####.json` and `people-cluster-####.bin` artifacts under `data/national/primed-cache/`.
- Each cluster keeps people nodes as the core payload and only includes bridge firms that are shared by multiple people in the cluster and stay under the bridge-firm size cap.
- `people-cluster-map.json` stores the cluster manifest plus the person-to-cluster map for fast lookup.
- The upload scripts treat these files the same way as the existing primed bundles, so the cluster family can be deployed without a separate Redis format.
