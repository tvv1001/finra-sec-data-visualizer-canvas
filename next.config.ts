import type { NextConfig } from 'next';

// Data is served from Redis — exclude all large local data files from serverless bundles.
const allRoutes = '/**';

const nextConfig: NextConfig = {
	// output: 'standalone',
	// Allow Playwright / local tools that hit 127.0.0.1 while the app is on localhost.
	allowedDevOrigins: ['127.0.0.1', 'localhost'],
	// Compress API + page responses with gzip/brotli
	compress: true,
	outputFileTracingExcludes: {
		[allRoutes]: ['./data/national/**', './data/raw/**', './data/primed-cache/**', './data/cache-binary/**', './data/build_manifest.json', './data/locations.json'],
	},
	experimental: {
		// Allow huge graph JSON to be serialised through getServerSideProps / route handlers
		largePageDataBytes: 128 * 1024 * 1024, // 128 MB
	},
	async headers() {
		return [
			{
				source: '/api/:path*',
				headers: [
					{ key: 'Access-Control-Allow-Credentials', value: 'true' },
					{ key: 'Access-Control-Allow-Origin', value: '*' },
					{ key: 'Access-Control-Allow-Methods', value: 'GET,OPTIONS,PATCH,DELETE,POST,PUT' },
					{ key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version' },
				],
			},
			{
				source: '/sw.js',
				headers: [
					{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
					{ key: 'Pragma', value: 'no-cache' },
					{ key: 'Expires', value: '0' },
				],
			},
		];
	},
};

export default nextConfig;
