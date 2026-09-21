'use client';

import { Analytics } from '@vercel/analytics/react';
import { useEffect } from 'react';
import { isAnalyticsExcluded, persistAnalyticsOptOut } from '@/lib/analyticsExclusion';

function hasOptOutCookie(): boolean {
	if (typeof document === 'undefined') return false;
	return document.cookie
		.split(';')
		.map((part) => part.trim())
		.some((part) => part === 'disable_analytics=1');
}

export default function AnalyticsClient() {
	useEffect(() => {
		if (typeof window !== 'undefined') {
			const urlParams = new URLSearchParams(window.location.search);
			if (urlParams.get('disable_analytics') === '1') {
				// Persist as a long-lived (2yr) first-party cookie + localStorage so this
				// machine's browser stays opted out automatically on every future visit.
				persistAnalyticsOptOut();
				console.log('Analytics disabled for this browser via URL parameter (persists for 2 years).');
			}
		}
		// Kick off the optional IP-based exclusion check as early as possible so the
		// opt-out flag is set (and beforeSend can pick it up) before any automatic
		// pageview fires. No-op if ANALYTICS_EXCLUDED_IPS isn't configured.
		isAnalyticsExcluded();
	}, []);

	// Client-only beforeSend handler — safe to access window/document here
	const beforeSend = (event: any) => {
		try {
			if (typeof window !== 'undefined') {
				const host = window.location.hostname;
				if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
					return null;
				}
				if (hasOptOutCookie() || window.localStorage.getItem('disable_analytics') === '1') {
					return null;
				}
			}

			// drop pageviews for private paths if present
			if (event?.type === 'pageview' && typeof (event as any)?.path === 'string' && (event as any).path.includes('/private')) {
				return null;
			}

			return event;
		} catch (err) {
			return event;
		}
	};

	return <Analytics beforeSend={beforeSend} />;
}
