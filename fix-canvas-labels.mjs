import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph-canvas.ts', 'utf8');

// 1. Remove hoverNodeId from labelCandidateIds so we don't force label on hover
content = content.replace(
	/hoverNodeId === id \|\|/g,
	''
);

// 2. Make selected and focused nodes bold as well, so they don't lose large status when screen clicked (if they stay selected)
content = content.replace(
	/const isBoldLabel = isForcedLabel;/g,
	'const isBoldLabel = isForcedLabel || isNodeSelected || isFocused;'
);

fs.writeFileSync('src/lib/finra-graph-canvas.ts', content);
