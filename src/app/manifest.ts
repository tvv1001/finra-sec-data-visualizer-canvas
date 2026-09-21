import type { MetadataRoute } from 'next';

const siteUrl = 'https://finra-data-chart-next-02.vercel.app';

export default function manifest(): MetadataRoute.Manifest {
	return {
		id: '/',
		name: 'FINRA Network Graph',
		short_name: 'FINRA Graph',
		description: 'Explore FINRA BrokerCheck and SEC AdviserInfo relationships in an interactive network graph for people, firms, control entities, registrations, and disclosures.',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		orientation: 'portrait',
		background_color: '#F5F0E4',
		theme_color: '#F97316',
		categories: ['finance', 'business', 'productivity'],
		lang: 'en',
		icons: [
			{
				src: '/icon-192.png',
				sizes: '192x192',
				type: 'image/png',
			},
			{
				src: '/icon-512.png',
				sizes: '512x512',
				type: 'image/png',
			},
			{
				src: '/icon-512-maskable.png',
				sizes: '512x512',
				type: 'image/png',
				purpose: 'maskable',
			},
		],
		screenshots: [
			{
				src: '/graph-screenshot.png',
				sizes: '1280x720',
				type: 'image/png',
				form_factor: 'wide',
				label: 'FINRA Network Graph overview',
			},
		],
		related_applications: [],
		prefer_related_applications: false,
	};
}
