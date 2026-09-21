const fs = require('fs');
let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	"const zoomTarget = canvasModeActive ? d3.select('#fg-main') : svg;\n\tzoomTarget.call(zoom as any).on('dblclick.zoom', null);",
	"svg.call(zoom as any).on('dblclick.zoom', null);"
);

content = content.replace(
	"const zoomTarget2 = canvasModeActive ? d3.select('#fg-main') : svg;\n\tzoomTarget2.call(zoom);",
	"svg.call(zoom);"
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
console.log('Reverted zoom patch');
