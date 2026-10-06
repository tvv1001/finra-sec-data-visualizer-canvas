import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const targetStr = `		try {
			applyStatusPresentation?.('Layout paused to protect memory — pan/zoom still work. Click Refresh Layout if needed.', {
				transient: true,
				dismissible: true,
			});
		} catch {
			/* status chrome may not be ready */
		}`;

content = content.replace(targetStr, `		// message removed per user request`);

fs.writeFileSync('src/lib/finra-graph.ts', content);
