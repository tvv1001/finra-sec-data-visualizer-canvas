import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/const ON_SCREEN_DETAIL_FETCH_BATCH_SIZE = 5;/g,
	'const ON_SCREEN_DETAIL_FETCH_BATCH_SIZE = 20;'
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
