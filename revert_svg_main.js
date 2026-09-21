const fs = require('fs');
let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	"const svg = canvasModeActive ? d3.select('#fg-main') : d3.select('#fg-svg');",
	"const svg = canvasModeActive ? d3.select('#fg-canvas') : d3.select('#fg-svg');"
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
console.log('Reverted svgSel to fg-canvas');
