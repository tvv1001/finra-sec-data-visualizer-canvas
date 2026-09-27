const fs = require('fs');
const tsPath = 'src/lib/finra-graph.ts';
let ts = fs.readFileSync(tsPath, 'utf8');

const newFunc = `
function handleClearNonLogOutsideClick(event: MouseEvent) {
	if (clearNonLogClickStage === 1) return;
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest('[data-fg-graph-action="clear-non-log"]')) return;
	clearNonLogClickStage = 1;
	syncClearNonLogButtonState();
}
`;

if (!ts.includes('function handleClearNonLogOutsideClick')) {
	ts = ts.replace(
		`function handleSelectionLogClearLabelsOutsideClick(event: MouseEvent) {`,
		newFunc + `\nfunction handleSelectionLogClearLabelsOutsideClick(event: MouseEvent) {`
	);
}

const targetEvent = `document.addEventListener('click', handleSelectionLogClearLabelsOutsideClick);`;
const replacementEvent = `document.addEventListener('click', handleSelectionLogClearLabelsOutsideClick);\n	document.addEventListener('click', handleClearNonLogOutsideClick);`;

if (!ts.includes('handleClearNonLogOutsideClick);')) {
	ts = ts.replace(targetEvent, replacementEvent);
}

fs.writeFileSync(tsPath, ts);
console.log("Updated finra-graph.ts with outside click handler for clear non log.");
