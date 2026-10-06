import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/const MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND = 12;/g,
	'const MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND = 60;'
);

content = content.replace(
	/const AUTO_EXPANSION_DIRECT_NEIGHBOR_LIMIT = 12;/g,
	'const AUTO_EXPANSION_DIRECT_NEIGHBOR_LIMIT = 60;'
);

content = content.replace(
	/const SIDEBAR_CONNECTIONS_PREVIEW_LIMIT = 24;/g,
	'const SIDEBAR_CONNECTIONS_PREVIEW_LIMIT = 100;'
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
