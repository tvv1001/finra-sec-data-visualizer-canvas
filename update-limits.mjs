import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/const MAX_TEXT_SEARCH_HITS_BASE = 200;/g,
	'const MAX_TEXT_SEARCH_HITS_BASE = 1000;'
);

content = content.replace(
	/const MAX_TEXT_SEARCH_HITS_DENSE = 80;/g,
	'const MAX_TEXT_SEARCH_HITS_DENSE = 400;'
);

content = content.replace(
	/const ROWS = '200';/g,
	"const ROWS = '1000';"
);

content = content.replace(
	/extractHits\(secResp\)\].slice\(0, 200\);/g,
	'extractHits(secResp)].slice(0, 1000);'
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
