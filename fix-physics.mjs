import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/velocityDecay:\s+isHuge \? 0\.65\s+: isLarge \? 0\.55\s+: 0\.48,/g,
	`velocityDecay:
				isHuge ? 0.88
				: isLarge ? 0.8
				: 0.6,`
);

content = content.replace(
	/velocityDecay:\s+isHuge \? 0\.55\s+: isLarge \? 0\.48\s+: 0\.42,/g,
	`velocityDecay:
			isHuge ? 0.8
			: isLarge ? 0.75
			: 0.5,`
);

content = content.replace(
	/\.velocityDecay\(isLarge \? 0\.46 : 0\.38\)/g,
	`.velocityDecay(isHuge ? 0.6 : isLarge ? 0.5 : 0.4)`
);

content = content.replace(
	/alphaDecay:\s+isHuge \? 0\.024\s+: isLarge \? 0\.016\s+: 0\.012,/g,
	`alphaDecay:
			isHuge ? 0.028
			: isLarge ? 0.02
			: 0.016,`
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
