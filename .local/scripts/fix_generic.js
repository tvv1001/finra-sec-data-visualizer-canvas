const fs = require('fs');
const file = 'src/lib/finra-graph.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. In getLinkRenderPriority, make "previous" lines go to bottom or mid
// Actually, we can keep the priorities and just re-order the groups in orderGraphVisualLayers.
// priority 0 (inactive) -> bottom
// priority 4 (previous) -> top
// priority 1, 2 (current) -> mid

// The user wants all links below nodes. 
// "disabled lines ... lowest level"
// "current connections ... next level down" (above disabled)
// So we can insert them before `nodesEl` in the order:
// 1. linkBottomGroup, arrowBottomGroup (disabled)
// 2. linkTopGroup, arrowTopGroup (previous / disabled)
// 3. linkMidGroup, arrowMidGroup (current connections)

let replaceTarget = `
	// Stacking: bottom + mid links under nodes/labels; previous/disabled (top) may sit above.
	try {
		if (nodeGroup && nodeGroup.node()) {
			const nodesEl = nodeGroup.node();
			const parent = nodesEl.parentNode;
			if (parent) {
				const underNodes = [linkBottomGroup?.node(), arrowBottomGroup?.node(), linkMidGroup?.node(), arrowMidGroup?.node()].filter(Boolean);
				for (const el of underNodes) {
					if (el.parentNode === parent) parent.insertBefore(el, nodesEl);
				}
				const overNodes = [linkTopGroup?.node(), arrowTopGroup?.node()].filter(Boolean);
				for (const el of overNodes) {
					if (el.parentNode !== parent) continue;
					if (nodesEl.nextSibling) parent.insertBefore(el, nodesEl.nextSibling);
					else parent.appendChild(el);
				}
			}
		}
	} catch (e) {
		// Ignore DOM manipulation errors — non-fatal
	}
`;

let replacement = `
	// Stacking: all links under nodes. Disabled/previous lowest, current mid.
	try {
		if (nodeGroup && nodeGroup.node()) {
			const nodesEl = nodeGroup.node();
			const parent = nodesEl.parentNode;
			if (parent) {
				// lowest: disabled endpoints (bottom) + previous history lines (top)
				// next: current connections (mid)
				const underNodes = [
					linkBottomGroup?.node(), arrowBottomGroup?.node(),
					linkTopGroup?.node(), arrowTopGroup?.node(),
					linkMidGroup?.node(), arrowMidGroup?.node()
				].filter(Boolean);
				
				for (const el of underNodes) {
					if (el && el.parentNode === parent) parent.insertBefore(el, nodesEl);
				}
			}
		}
	} catch (e) {
		// Ignore DOM manipulation errors — non-fatal
	}
`;

code = code.replace(replaceTarget.trim(), replacement.trim());
fs.writeFileSync(file, code);
