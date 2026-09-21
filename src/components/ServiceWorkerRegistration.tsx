'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegistration() {
	useEffect(() => {
		const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
		if (process.env.NODE_ENV !== 'production' || isLocalhost || !('serviceWorker' in navigator)) {
			if ('serviceWorker' in navigator && isLocalhost) {
				navigator.serviceWorker.getRegistrations().then((registrations) => {
					for (const registration of registrations) {
						void registration.unregister();
					}
				});
			}
			if (window.caches && isLocalhost) {
				window.caches.keys().then((names) => {
					for (const name of names) {
						void window.caches.delete(name);
					}
				});
			}
			return;
		}

		let hasReloadedForUpdate = false;

		const promptWaitingWorkerToActivate = (registration: ServiceWorkerRegistration) => {
			if (registration.waiting && navigator.serviceWorker.controller) {
				registration.waiting.postMessage({ type: 'SKIP_WAITING' });
			}
		};

		const watchInstallingWorker = (registration: ServiceWorkerRegistration) => {
			const worker = registration.installing;
			if (!worker) {
				return;
			}

			worker.addEventListener('statechange', () => {
				if (worker.state === 'installed') {
					promptWaitingWorkerToActivate(registration);
				}
			});
		};

		const register = async () => {
			try {
				// Must be stable across reloads. Date.now() made every visit look like a new
				// worker; skipWaiting + clients.claim then fired controllerchange and reloaded
				// the page in a loop on production.
				const buildStamp =
					process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
					process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID ||
					'static';
				const registration = await navigator.serviceWorker.register(`/sw.js?v=${buildStamp}`, {
					updateViaCache: 'none',
				});

				promptWaitingWorkerToActivate(registration);
				watchInstallingWorker(registration);
				registration.addEventListener('updatefound', () => {
					watchInstallingWorker(registration);
				});

				void registration.update();

				const refreshRegistration = () => {
					void registration.update();
				};

				const handleVisibilityChange = () => {
					if (document.visibilityState === 'visible') {
						refreshRegistration();
					}
				};

				const handleControllerChange = () => {
					if (hasReloadedForUpdate) {
						return;
					}

					try {
						const reloadKey = `finra-sw-reloaded:${buildStamp}`;
						if (sessionStorage.getItem(reloadKey) === '1') {
							return;
						}
						sessionStorage.setItem(reloadKey, '1');
					} catch {
						// sessionStorage may be unavailable
					}

					hasReloadedForUpdate = true;
					window.location.reload();
				};

				navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
				window.addEventListener('focus', refreshRegistration);
				document.addEventListener('visibilitychange', handleVisibilityChange);

				return () => {
					navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
					window.removeEventListener('focus', refreshRegistration);
					document.removeEventListener('visibilitychange', handleVisibilityChange);
				};
			} catch (error) {
				console.error('Service worker registration failed:', error);
			}
		};

		let cleanup: (() => void) | undefined;

		const startRegistration = () => {
			void register().then((teardown) => {
				cleanup = teardown;
			});
		};

		if (document.readyState === 'complete') {
			startRegistration();
		} else {
			window.addEventListener('load', startRegistration, { once: true });
		}

		return () => {
			window.removeEventListener('load', startRegistration);
			cleanup?.();
		};
	}, []);

	return null;
}
