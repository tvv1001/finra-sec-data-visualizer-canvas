import fs from 'fs';

let content = fs.readFileSync('src/app/api/dashboard/refresh/route.ts', 'utf-8');

// 1. Remove the global variable and modify prefetchPayloadsBatch
content = content.replace(
  /let batchPayloadsMap: Map<string, any> \| null = null;\s+async function prefetchPayloadsBatch\(cards: CacheCard\[\]\) \{[\s\S]*?\}\s+async function loadCachedIndividualPayload/m,
  `async function prefetchPayloadsBatch(cards: CacheCard[]): Promise<Map<string, any>> {
	const map = new Map<string, any>();
	const redis = getRedisClientInstance({
		url: process.env.UPSTASH_REDIS_REST_URL || '',
		token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
	});
	if (!redis) return map;

	const keysToFetch = new Set<string>();
	for (const card of cards) {
		for (const sourceEntry of card.sources) {
			keysToFetch.add(\`\${sourceEntry.source}:\${card.entity}:\${card.id}\`);
		}
	}
	const keys = Array.from(keysToFetch);
	if (keys.length === 0) return map;

	try {
		const chunkSize = 20;
		for (let j = 0; j < keys.length; j += chunkSize) {
			const chunk = keys.slice(j, j + chunkSize);
			const results = await redis.mget(...chunk);
			for (let i = 0; i < chunk.length; i++) {
				const raw = results[i];
				if (raw == null) continue;
				
				let parsed = null;
				if (typeof raw === 'string') {
					const decompressed = decompressPayload(raw);
					try {
						parsed = JSON.parse(decompressed);
					} catch {
						parsed = null;
					}
				} else {
					parsed = raw;
				}
				
				if (parsed != null) {
					map.set(chunk[i], parsed);
				}
			}
			// Small delay to allow GC and keep event loop healthy
			await new Promise(r => setTimeout(r, 5));
		}
	} catch (error) {
		console.warn('Batch fetch failed', error);
	}
	return map;
}

async function loadCachedIndividualPayload`
);

// 2. Modify loadCachedIndividualPayload to accept payloadsMap
content = content.replace(
  /async function loadCachedIndividualPayload\(source: 'finra' \| 'sec', id: string\) \{\s+const key = `\$\{source\}:individual:\$\{id\}`;\s+let payload = batchPayloadsMap\?\.get\(key\);/g,
  `async function loadCachedIndividualPayload(source: 'finra' | 'sec', id: string, payloadsMap?: Map<string, any>) {\n\tconst key = \`\${source}:individual:\${id}\`;\n\tlet payload = payloadsMap?.get(key);`
);

// 3. Modify loadCachedFirmPayload to accept payloadsMap
content = content.replace(
  /async function loadCachedFirmPayload\(source: 'finra' \| 'sec', id: string\) \{\s+const key = `\$\{source\}:firm:\$\{id\}`;\s+let payload = batchPayloadsMap\?\.get\(key\);/g,
  `async function loadCachedFirmPayload(source: 'finra' | 'sec', id: string, payloadsMap?: Map<string, any>) {\n\tconst key = \`\${source}:firm:\${id}\`;\n\tlet payload = payloadsMap?.get(key);`
);

// 4. Modify normalizeCardSourcesForDisplay
content = content.replace(
  /async function normalizeCardSourcesForDisplay\(card: CacheCard\): Promise<CacheCard & \{ hasVerifiedPayload\?: boolean \}> \{([\s\S]*?detail = await loadCachedIndividualPayload\(sourceEntry.source, card.id\);[\s\S]*?detail = await loadCachedFirmPayload\(sourceEntry.source, card.id\);)/m,
  `async function normalizeCardSourcesForDisplay(card: CacheCard, payloadsMap?: Map<string, any>): Promise<CacheCard & { hasVerifiedPayload?: boolean }> {$1`
);
content = content.replace(
  /detail = await loadCachedIndividualPayload\(sourceEntry.source, card.id\);/g,
  `detail = await loadCachedIndividualPayload(sourceEntry.source, card.id, payloadsMap);`
);
content = content.replace(
  /detail = await loadCachedFirmPayload\(sourceEntry.source, card.id\);/g,
  `detail = await loadCachedFirmPayload(sourceEntry.source, card.id, payloadsMap);`
);

// 5. Modify buildCardSummary
content = content.replace(
  /async function buildCardSummary\(card: CacheCard\) \{([\s\S]*?const detail = await loadCachedIndividualPayload\(sourceEntry.source, card.id\);[\s\S]*?const firmDetail = await loadCachedFirmPayload\(sourceEntry.source, card.id\);)/m,
  `async function buildCardSummary(card: CacheCard, payloadsMap?: Map<string, any>) {$1`
);
content = content.replace(
  /const detail = await loadCachedIndividualPayload\(sourceEntry.source, card.id\);/g,
  `const detail = await loadCachedIndividualPayload(sourceEntry.source, card.id, payloadsMap);`
);
content = content.replace(
  /const firmDetail = await loadCachedFirmPayload\(sourceEntry.source, card.id\);/g,
  `const firmDetail = await loadCachedFirmPayload(sourceEntry.source, card.id, payloadsMap);`
);


// 6. Modify listCacheCards
content = content.replace(
  /await prefetchPayloadsBatch\(cardsToProcess\);\s+const shownCards = await Promise.all\(\s+cardsToProcess.map\(async \(card\) => \{\s+const normalized = await normalizeCardSourcesForDisplay\(card\);\s+const summary = await buildCardSummary\(normalized\);\s+return normalizeCardForDisplay\(\{ \.\.\.normalized, \.\.\.summary \}\);\s+\}\),\s+\);\s+batchPayloadsMap = null;/m,
  `const payloadsMap = await prefetchPayloadsBatch(cardsToProcess);

	const shownCards = await Promise.all(
		cardsToProcess.map(async (card) => {
			const normalized = await normalizeCardSourcesForDisplay(card, payloadsMap);
			const summary = await buildCardSummary(normalized, payloadsMap);
			return normalizeCardForDisplay({ ...normalized, ...summary });
		}),
	);`
);

// 7. Modify listNewCrds
content = content.replace(
  /await prefetchPayloadsBatch\(topCardsToProcess\);\s+const formattedWithNulls = await Promise.all\(\s+topCardsToProcess.map\(async \(card\) => \{\s+const normalizedSources = await normalizeCardSourcesForDisplay\(card\);\s+\/\/ Skip CRDs[\s\S]*?if \(normalizedSources.hasVerifiedPayload === false\) return null;\s+const summary = await buildCardSummary\(normalizedSources\);\s+const normalized = normalizeCardForDisplay\(\{ \.\.\.normalizedSources, \.\.\.summary \}\);/m,
  `const payloadsMap = await prefetchPayloadsBatch(topCardsToProcess);

	const formattedWithNulls = await Promise.all(
		topCardsToProcess.map(async (card) => {
			const normalizedSources = await normalizeCardSourcesForDisplay(card, payloadsMap);
			// Skip CRDs whose detail payload was never actually cached in Redis (e.g. an id present
			// only in the \`dashboard:highest-crds:*\` zset). Without a real payload we can't verify
			// the FINRA/SEC scopes or resolve a real name, so surfacing it here previously showed a
			// fabricated "Individual <crd>" placeholder with both source tags checked, which looked
			// like a data/decoding error.
			if (normalizedSources.hasVerifiedPayload === false) return null;
			const summary = await buildCardSummary(normalizedSources, payloadsMap);
			const normalized = normalizeCardForDisplay({ ...normalizedSources, ...summary });`
);

content = content.replace(/batchPayloadsMap = null;/g, '');

fs.writeFileSync('src/app/api/dashboard/refresh/route.ts', content);
