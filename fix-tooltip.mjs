import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph-canvas.ts', 'utf8');

content = content.replace(
	/if \(\!canvasTooltip\) \{/g,
	`if (!canvasTooltip || canvasTooltip.parentNode !== parentEl) {
		if (canvasTooltip && canvasTooltip.parentNode) canvasTooltip.remove();`
);

content = content.replace(
	/canvas = null;/g,
	`canvas = null;
	if (canvasTooltip) canvasTooltip.remove();
	canvasTooltip = null;`
);

fs.writeFileSync('src/lib/finra-graph-canvas.ts', content);
