'use client';

import { useEffect, useRef, useState } from 'react';
import { inject, pageview } from '@vercel/analytics';
import { isAnalyticsExcluded } from '@/lib/analyticsExclusion';

type BrowserLocationSnapshot = {
	path: string;
	route: string;
};

function readBrowserLocation(): BrowserLocationSnapshot {
	if (typeof window === 'undefined') {
		return {
			path: '/',
			route: '/',
		};
	}

	const { pathname, search } = window.location;
	return {
		path: `${pathname}${search}`,
		route: pathname || '/',
	};
}

export default function AnalyticsRouteBridge() {
	const [location, setLocation] = useState<BrowserLocationSnapshot>(() => readBrowserLocation());
	const pendingUpdateTimerRef = useRef<number | null>(null);
	const trackingEnabledRef = useRef<boolean>(false);

	useEffect(() => {
		if (typeof window === 'undefined') return;

		const host = window.location.hostname;
		// Disable tracking for local development and non-production builds.
		const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
		const isProduction = process.env.NODE_ENV === 'production';
		if (isLocalhost || !isProduction) {
			trackingEnabledRef.current = false;
			return;
		}

		let cancelled = false;
		isAnalyticsExcluded().then((excluded) => {
			if (cancelled || excluded) {
				trackingEnabledRef.current = false;
				return;
			}
			trackingEnabledRef.current = true;
			inject({
				debug: true,
				disableAutoTrack: true,
				framework: 'react',
			});
		});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		const flushLocationUpdate = () => {
			pendingUpdateTimerRef.current = null;
			setLocation((current) => {
				const next = readBrowserLocation();
				if (current.path === next.path && current.route === next.route) {
					return current;
				}
				return next;
			});
		};

		const scheduleLocationUpdate = () => {
			if (pendingUpdateTimerRef.current !== null) {
				return;
			}

			pendingUpdateTimerRef.current = window.setTimeout(flushLocationUpdate, 0);
		};

		const { history } = window;
		const originalPushState = history.pushState.bind(history);
		const originalReplaceState = history.replaceState.bind(history);

		history.pushState = function pushState(...args) {
			const result = originalPushState(...args);
			scheduleLocationUpdate();
			return result;
		};

		history.replaceState = function replaceState(...args) {
			const result = originalReplaceState(...args);
			scheduleLocationUpdate();
			return result;
		};

		window.addEventListener('popstate', scheduleLocationUpdate);
		scheduleLocationUpdate();

		return () => {
			history.pushState = originalPushState;
			history.replaceState = originalReplaceState;
			window.removeEventListener('popstate', scheduleLocationUpdate);
			if (pendingUpdateTimerRef.current !== null) {
				window.clearTimeout(pendingUpdateTimerRef.current);
				pendingUpdateTimerRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		if (!trackingEnabledRef.current) return;
		pageview({
			path: location.path,
			route: location.route,
		});
	}, [location]);

	return null;
}
