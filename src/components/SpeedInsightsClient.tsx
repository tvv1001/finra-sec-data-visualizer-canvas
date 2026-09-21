'use client';

import { SpeedInsights } from '@vercel/speed-insights/next';
import { useEffect, useState } from 'react';

function isLocalHost(): boolean {
	try {
		if (typeof window === 'undefined') return true;
		const host = window.location.hostname.toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return true;
	}
}

function isOptedOut(): boolean {
	try {
		if (typeof window === 'undefined') return false;
		if (window.localStorage.getItem('disable_analytics') === '1') return true;
		if (new URLSearchParams(window.location.search).get('disable_analytics') === '1') return true;
		if (document.cookie.split(';').map((s) => s.trim()).some((s) => s === 'disable_analytics=1')) return true;
	} catch {
		// ignore
	}
	return false;
}

function isWebVitalsStartTimeBug(message: string): boolean {
	return message.includes("reading 'startTime'") || message.includes('reading "startTime"');
}

export default function SpeedInsightsClient() {
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		setEnabled(!isLocalHost() && !isOptedOut());
	}, []);

	// web-vitals can throw when PerformanceObserver entries are GC'd mid-callback
	// (reportAllChanges → entry.startTime). That often fires after SPA/dashboard clicks.
	useEffect(() => {
		const onError = (event: ErrorEvent) => {
			if (isWebVitalsStartTimeBug(String(event.message || event.error?.message || ''))) {
				event.preventDefault();
			}
		};
		const onRejection = (event: PromiseRejectionEvent) => {
			const reason = event.reason;
			const message = reason instanceof Error ? reason.message : String(reason || '');
			if (isWebVitalsStartTimeBug(message)) {
				event.preventDefault();
			}
		};

		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onRejection);
		return () => {
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
		};
	}, []);

	if (!enabled) return null;

	return (
		<SpeedInsights
			beforeSend={(metric) => {
				try {
					if (!metric || typeof metric !== 'object') return null;
					return metric;
				} catch {
					return null;
				}
			}}
		/>
	);
}
