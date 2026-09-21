const fs = require('fs');
const file = 'src/lib/finra-graph.ts';
let code = fs.readFileSync(file, 'utf8');

const target = "if (nodeCount <= 100) {\n\t\tif (linkSel";
const replacement = `if (nodeCount <= 100) {
		if (linkSel && typeof linkSel.sort === 'function') {
			linkSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
		}

		if (arrowSel && typeof arrowSel.sort === 'function') {
			arrowSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
		}

		if (nodeSel && typeof nodeSel.sort === 'function') {
			nodeSel.sort((a, b) => comparePriorityWithTieBreak(getNodeRenderPriority(a, highlightState), getNodeRenderPriority(b, highlightState), a?.id, b?.id));
		}
	} else {
		// For larger graphs, use fast raise() to enforce the requested layers
		if (nodeSel && typeof nodeSel.filter === 'function') {
			try {
				nodeSel.filter((d) => {
					const pr = getNodeRenderPriority(d, highlightState);
					return pr > 1000 && pr < 10000;
				}).raise();
				
				nodeSel.filter((d) => {
					const pr = getNodeRenderPriority(d, highlightState);
					return pr >= 10000;
				}).raise();
			} catch (e) {
				// ignore
			}
		}
	}`;

// find the exact block:
const regex = /if \(nodeCount <= 100\) \{[\s\S]*?if \(nodeSel && typeof nodeSel\.sort === 'function'\) \{[\s\S]*?\}\n\t\}/;
code = code.replace(regex, replacement);
fs.writeFileSync(file, code);
