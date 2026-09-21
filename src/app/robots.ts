import type { MetadataRoute } from 'next';

const siteUrl = 'https://finra-data-chart-next-02.vercel.app';

export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: '*',
			allow: '/',
		},
		sitemap: `${siteUrl}/sitemap.xml`,
		host: siteUrl,
	};
}
