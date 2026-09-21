const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const s1 = `      ${"${row('Regulator', esc(d.regulator || '–'))}"}`;
const i1 = code.indexOf(s1);

const s2 = `			${"$"}{
				connections.length ?
					\`<div class="fg-section-title fg-section-title--sticky">Connected Nodes (\${connections.length})</div>`;
const i2 = code.indexOf(s2);

const s3 = `			<div class="fg-section-title fg-section-title--sticky">General Information</div>`;
const i3 = code.indexOf(s3);

const s4 = `      ${"$"}{
				controlConnections.length || (showFinra && staticOwnersToRender.length) ?
					\`
        <div class="fg-section-title fg-section-title--sticky">Form BD — Direct Owners &amp; Executive Officers (\${controlConnections.length + (showFinra ? staticOwnersToRender.length : 0)})</div>`;
const i4 = code.indexOf(s4);

const s5 = `						\`
							}
							return \`
						<div class="fg-owner-row fg-owner-row--static">
							\${nameHtml}
							\${posHtml}
						</div>
						\`;
						})
						.join('')
				:	''
			}
		</div>\`
				:	''
			}`;
const i5 = code.indexOf(s5) + s5.length;

if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < i4) {
  console.log("Indices not found", {i1, i2, i3, i4, i5});
  process.exit(1);
}

// We want to extract:
// A) The connections block: from i2 to i3
// B) The Form BD block: from i4 to i5
const connectionsBlock = code.substring(i2, i3);
const formBdBlock = code.substring(i4, i5);

// New structure:
// <...up to i2...>
// formBdBlock
// <...from i3 to i4...>
// connectionsBlock
// <...from i5 to end...>

const newCode = code.substring(0, i2) + formBdBlock + '\n' + code.substring(i3, i4) + connectionsBlock + code.substring(i5);

fs.writeFileSync('src/lib/finra-graph.ts', newCode);
console.log("Successfully reordered sections in src/lib/finra-graph.ts");
