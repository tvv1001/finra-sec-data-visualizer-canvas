const { getFullGraph } = require('../src/lib/graphStore');
const { collectNodeLocationRecords, nodeMatchesLocationSearch } = require('../src/lib/locationSearch');

async function main() {
	try {
		console.log("Loading graph...");
		const graph = await getFullGraph();
		console.log(`Loaded graph with ${graph?.nodes?.length || 0} nodes.`);

		const sampleNodes = graph?.nodes || [];

		// Test some searches
		const locationsToTest = ["Boston", "Tampa", "Dallas", "Miami", "New York"];
		for (const loc of locationsToTest) {
			console.log(`\nTesting location query: "${loc}"`);

			// Resolve refLat / refLon like route.ts does
			let refLat, refLon;
			const queryTerms = loc.toLowerCase().split(/[\s,]+/).filter(Boolean);
			for (const node of sampleNodes) {
				const records = collectNodeLocationRecords(node);
				const matchingRecord = records.find((rec) => {
					if (rec.latitude === undefined || rec.longitude === undefined) return false;
					const recordFullText = [rec.text, rec.city, rec.state, rec.postalCode, rec.country].filter(Boolean).join(' ').toLowerCase();
					return queryTerms.every((term) => recordFullText.includes(term));
				});
				if (matchingRecord) {
					refLat = matchingRecord.latitude;
					refLon = matchingRecord.longitude;
					break;
				}
			}

			console.log(`Resolved coordinates: refLat=${refLat}, refLon=${refLon}`);

			const matched = sampleNodes.filter(node => {
				return nodeMatchesLocationSearch(node, {
					locationQuery: loc,
					radius: 25,
					refLat,
					refLon
				});
			});
			console.log(`Matched ${matched.length} nodes.`);
			if (matched.length > 0) {
				console.log("Sample matched node names:", matched.slice(0, 5).map(n => n.label || n.id));
			}
		}
	} catch (err) {
		console.error("Error:", err);
	}
}

main();
