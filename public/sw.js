const serviceWorkerVersion = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const VERSION = `v-${serviceWorkerVersion}`;
const STATIC_CACHE = `finra-static-${VERSION}`;
const RUNTIME_CACHE = `finra-runtime-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
	'/',
	OFFLINE_URL,
	'/manifest.webmanifest',
	'/favicon.ico',
	'/favicon-32x32.png',
	'/favicon-16x16.png',
	'/pwa-icon.svg',
	'/icon-192.png',
	'/icon-512.png',
	'/icon-512-maskable.png',
	'/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(STATIC_CACHE)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.catch(() => undefined),
	);
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key)))));
	self.clients.claim();
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}
});

self.addEventListener('fetch', (event) => {
	const { request } = event;

	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);

	if (url.origin !== self.location.origin) {
		return;
	}

	if (url.pathname.startsWith('/api/')) {
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(networkFirstPage(request));
		return;
	}

	if (url.pathname.startsWith('/_next/static/') || ['style', 'script', 'worker', 'font', 'image'].includes(request.destination)) {
		event.respondWith(staleWhileRevalidate(request));
	}
});

async function networkFirstPage(request) {
	try {
		const response = await fetch(request);
		const cache = await caches.open(RUNTIME_CACHE);
		cache.put(request, response.clone());
		return response;
	} catch {
		const cachedPage = await caches.match(request);
		if (cachedPage) {
			return cachedPage;
		}

		return caches.match(OFFLINE_URL);
	}
}

async function staleWhileRevalidate(request) {
	const cache = await caches.open(RUNTIME_CACHE);
	const cached = await cache.match(request);
	const networkPromise = fetch(request)
		.then((response) => {
			cache.put(request, response.clone());
			return response;
		})
		.catch(() => cached);

	return cached || networkPromise;
}
