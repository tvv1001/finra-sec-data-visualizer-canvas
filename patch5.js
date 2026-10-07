const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const target = `\t\t\tif (globalState.refreshFinalizeLayoutFn) globalState.refreshFinalizeLayoutFn();
\t\t\tdocument.removeEventListener('mousedown', stopAnimationOnClick);`;

const replacement = `\t\t\tif (globalState.refreshFinalizeLayoutFn) globalState.refreshFinalizeLayoutFn();
\t\t\ttry { globalState.simulation?.stop?.(); } catch {}
\t\t\tdocument.removeEventListener('mousedown', stopAnimationOnClick);`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('src/lib/finra-graph.ts', code);
    console.log("Success");
} else {
    console.log("Target not found");
}
