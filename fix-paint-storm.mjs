import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const targetStr = `			const stormLimit =
				fetchHot ? 8
				: moving ? 12
				: 28; // idle/hover: allow more; continuous 60fps still trips (~40ms floor)
			if (paintStormPaintCount >= stormLimit && (fetchHot || moving || paintStormPaintCount >= 40)) {
				emergencyStopLayoutPaintStorm(
					fetchHot ? 'fetch-reflow-paint-storm'
					: moving ? 'sim-paint-storm'
					: 'idle-paint-storm',
				);
			}`;

const replacementStr = `			const count = globalState.layoutNodes?.length || 0;
			const stormLimit =
				fetchHot ? 24
				: moving ? 32
				: 60; // Allow much higher throughput
			// Only protect memory on dense graphs (Skia realloc bug)
			if (count > 250 && paintStormPaintCount >= stormLimit && (fetchHot || moving || paintStormPaintCount >= 60)) {
				emergencyStopLayoutPaintStorm(
					fetchHot ? 'fetch-reflow-paint-storm'
					: moving ? 'sim-paint-storm'
					: 'idle-paint-storm',
				);
			}`;

content = content.replace(targetStr, replacementStr);
fs.writeFileSync('src/lib/finra-graph.ts', content);
