import fs from 'fs';

let content = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

content = content.replace(
	/velocityDecay:\s+isHuge \? 0\.88\s+: isLarge \? 0\.9\s+: 0\.92,/m,
	`velocityDecay:
				isHuge ? 0.65
				: isLarge ? 0.55
				: 0.48,`
);

content = content.replace(
	/velocityDecay:\s+isHuge \? 0\.8\s+: isLarge \? 0\.84\s+: 0\.9,/m,
	`velocityDecay:
			isHuge ? 0.55
			: isLarge ? 0.48
			: 0.42,`
);

content = content.replace(
	/alphaDecay:\s+isHuge \? 0\.028\s+: isLarge \? 0\.02\s+: 0\.016,/m,
	`alphaDecay:
			isHuge ? 0.024
			: isLarge ? 0.016
			: 0.012,`
);

content = content.replace(
	/\.velocityDecay\(isLarge \? 0\.54 : 0\.46\)/g,
	`.velocityDecay(isLarge ? 0.46 : 0.38)`
);

fs.writeFileSync('src/lib/finra-graph.ts', content);
