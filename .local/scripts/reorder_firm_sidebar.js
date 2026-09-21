const fs = require('fs');

const file = 'src/lib/finra-graph.ts';
let code = fs.readFileSync(file, 'utf8');

// The block we want to reorder starts around `<div class="fg-section-title fg-section-title--sticky">Registration</div>`
// and ends after the `Form BD` block.

const startRegex = /(?:\$\{row\('Regulator', esc\(d\.regulator \|\| '–'\)\)\}\n)/;
const connectionsRegex = /(\t\t\t\$\{\n\t\t\t\tconnections\.length \?.*?:\t''\n\t\t\t\}\n\t\t\t\$\{\n\t\t\t\tcurrentConnections\.length \?.*?:\t''\n\t\t\t\}\n\t\t\t\$\{\n\t\t\t\tpreviousConnections\.length \?.*?:\t''\n\t\t\t\}\n)/s;
const formBdRegex = /(\t\t\t\$\{\n\t\t\t\tcontrolConnections\.length \|\| \(showFinra && staticOwnersToRender\.length\) \?.*?:\t''\n\t\t\t\}\n)/s;

let matchReg = code.match(startRegex);
if (!matchReg) {
  console.log("Could not find Regulator");
  process.exit(1);
}

let matchConn = code.match(connectionsRegex);
if (!matchConn) {
  // Let's try a more flexible regex for connections
  console.log("Could not find connections block");
  process.exit(1);
}

let matchBd = code.match(formBdRegex);
if (!matchBd) {
  console.log("Could not find Form BD block");
  process.exit(1);
}

console.log("Found all blocks. Now reordering...");

// We want to remove the connections block and the Form BD block from their current positions.
// Then insert Form BD right after `Regulator` row.
// Then insert connections at the very end of `</div>`
