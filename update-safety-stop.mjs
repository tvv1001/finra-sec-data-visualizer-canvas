import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/safetyStopMs:\s+isHuge \? 2400\s+: isLarge \? 3200\s+: 4200,/m,
	`safetyStopMs:
			isHuge ? 3200
			: isLarge ? 4800
			: 6000,`
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
