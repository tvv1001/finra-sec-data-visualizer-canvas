import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/const TEXT_SEARCH_DETAIL_HYDRATION_LIMIT = 5;/g,
	'const TEXT_SEARCH_DETAIL_HYDRATION_LIMIT = 20;'
);

content = content.replace(
	/const TEXT_SEARCH_DETAIL_HYDRATION_CONCURRENCY = 5;/g,
	'const TEXT_SEARCH_DETAIL_HYDRATION_CONCURRENCY = 20;'
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
