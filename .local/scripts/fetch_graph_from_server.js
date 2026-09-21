(async () => {
	try {
		const fs = require('fs');
		const fetchFn = globalThis.fetch;
		if (typeof fetchFn !== 'function') {
			throw new Error('Global fetch is not available in this Node runtime');
		}
		const url = process.env.FINRA_LOCAL_URL || 'http://localhost:4444';
		if (process.env.VERCEL && (!process.env.FINRA_LOCAL_URL || /^https?:\/\/localhost(?::\d+)?\/?$/i.test(url))) {
			console.log('Vercel build: skipping local graph fetch.');
			process.exit(0);
		}
		const api = `${url.replace(/\/$/, '')}/api/finra/graph?limit=10000`;
		console.log('Fetching', api);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		const r = await fetchFn(api, { signal: controller.signal });
		clearTimeout(timeout);
		if (!r.ok) {
			console.error('Fetch failed', r.status);
			process.exit(2);
		}
		const obj = await r.json();
		if (!obj || (!Array.isArray(obj.nodes) && !obj.meta)) {
			console.error('Unexpected response');
			process.exit(3);
		}
		const localPath = 'data/national/finra-graph.json';
		const bak = localPath + '.bak-from-server-' + Date.now();
		try {
			if (fs.existsSync(localPath)) fs.copyFileSync(localPath, bak);
		} catch {}
		fs.writeFileSync(localPath, JSON.stringify(obj, null, 2));
		console.log('WROTE', localPath, 'nodes=', (obj.nodes || []).length, 'links=', (obj.links || []).length);
	} catch (e) {
		console.error('ERROR', (e && e.message) || e);
		process.exit(1);
	}
})();
