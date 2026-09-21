const zlib = require('node:zlib');
const https = require('node:https');

// Simulate the fetcher inside the route
const fetchQuery = 'hl=true&includePrevious=true&wt=json';
const fetchOptions = {
	headers: {
		'Accept': 'application/json',
		'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		'Referer': 'https://brokercheck.finra.org/',
	},
};

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, fetchOptions, (res) => {
			let body = '';
			res.on('data', (d) => (body += d));
			res.on('end', () => {
				if (res.statusCode === 404) {
					resolve(null);
					return;
				}
				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(5000, () => req.destroy(new Error('Timeout')));
	});
}

async function main() {
	const crd = '3104103';
	console.log(`Simulating individual route for CRD ${crd}`);

	const finraData = await fetchJson(`https://api.brokercheck.finra.org/search/individual/${crd}?${fetchQuery}`).catch(err => {
		console.error('FINRA fetch failed:', err.message);
		return null;
	});

	const secData = await fetchJson(`https://api.adviserinfo.sec.gov/search/individual/${crd}?${fetchQuery}`).catch(err => {
		console.error('SEC fetch failed:', err.message);
		return null;
	});

	console.log('FINRA Data exists:', !!finraData);
	console.log('SEC Data exists:', !!secData);
}

main().catch(console.error);
