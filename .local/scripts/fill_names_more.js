const fs = require('fs');
const path = require('path');

const csvPath = 'crd-list-generic.csv';
const outCsvPath = 'crd-list-generic-filled-more.csv';
const firmConnectionsDir = 'data/firm-connections';

const genericMap = new Map();
const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
const header = lines[0];
for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // CSV format: Type,CRD,Name,Has_Detail_Page,In_FINRA,In_SEC
    // We want to handle commas in names correctly. The simplest way is to extract by splitting up to the 2nd comma, then getting the name.
    // Wait, let's use a simple regex for CSV parsing.
    const match = line.match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
    if (match) {
        genericMap.set(match[2], { type: match[1], crd: match[2], name: match[3] });
    }
}

let foundCount = 0;

if (fs.existsSync(firmConnectionsDir)) {
    const files = fs.readdirSync(firmConnectionsDir);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const p = path.join(firmConnectionsDir, file);
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (data.currentConnections) {
                for (const conn of data.currentConnections) {
                    if (conn.individualId && conn.name) {
                        const cid = String(conn.individualId);
                        if (genericMap.has(cid) && !genericMap.get(cid).name) {
                            genericMap.get(cid).name = conn.name;
                            foundCount++;
                        }
                    }
                }
            }
            if (data.previousConnections) {
                for (const conn of data.previousConnections) {
                    if (conn.individualId && conn.name) {
                        const cid = String(conn.individualId);
                        if (genericMap.has(cid) && !genericMap.get(cid).name) {
                            genericMap.get(cid).name = conn.name;
                            foundCount++;
                        }
                    }
                }
            }
        } catch(e) {
            // ignore
        }
    }
}

console.log(`Found additional names for ${foundCount} generic individuals from firm connections.`);

const out = fs.createWriteStream(outCsvPath);
out.write(header + '\n');
for (const [crd, val] of genericMap.entries()) {
    let safeName = (val.name || '').replace(/"/g, '""');
    out.write(`${val.type},${crd},"${safeName}",false,false,false\n`);
}
out.end();
console.log(`Wrote updated file to ${outCsvPath}`);
