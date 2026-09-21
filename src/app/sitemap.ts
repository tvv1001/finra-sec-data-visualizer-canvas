import type { MetadataRoute } from 'next';

const siteUrl = 'https://finra-data-chart-next-02.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
	const now = new Date();

	return [
		{
			url: siteUrl,
			lastModified: now,
			changeFrequency: 'daily',
			priority: 1,
		},
	];
}
