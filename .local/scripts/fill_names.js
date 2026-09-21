const fs = require('fs');
const path = require('path');

const csvPath = 'crd-list-generic.csv';
const outCsvPath = 'crd-list-generic-filled.csv';
const rawDir1 = 'data/raw/brokercheck.finra.org';
const rawDir2 = 'data/raw/adviserinfo.sec.gov';

const genericMap = new Map(); // id -> { type, name }
const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
const header = lines[0];
for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    const type = parts[0];
    const crd = parts[1];
    genericMap.set(crd, { type, name: '' });
}

let foundCount = 0;

function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const p = path.join(dir, file);
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!data.hits || !data.hits.hits || !data.hits.hits[0] || !data.hits.hits[0]._source) continue;
            
            const contentStr = data.hits.hits[0]._source.content;
            if (!contentStr) continue;
            const content = JSON.parse(contentStr);
            
            // Check previous employments (for individuals) to find firm names
            if (content.previousEmployments) {
                for (const emp of content.previousEmployments) {
                    if (emp.firmId && emp.firmName) {
                        const fid = String(emp.firmId);
                        if (genericMap.has(fid) && !genericMap.get(fid).name) {
                            genericMap.get(fid).name = emp.firmName;
                            foundCount++;
                        }
                    }
                }
            }
            if (content.currentEmployments) {
                for (const emp of content.currentEmployments) {
                    if (emp.firmId && emp.firmName) {
                        const fid = String(emp.firmId);
                        if (genericMap.has(fid) && !genericMap.get(fid).name) {
                            genericMap.get(fid).name = emp.firmName;
                            foundCount++;
                        }
                    }
                }
            }
            // Firm direct owners
            if (content.directOwners) {
                for (const own of content.directOwners) {
                    if (own.crd && own.legalName) {
                        const cid = String(own.crd);
                        if (genericMap.has(cid) && !genericMap.get(cid).name) {
                            genericMap.get(cid).name = own.legalName;
                            foundCount++;
                        }
                    }
                }
            }
            if (content.indirectOwners) {
                for (const own of content.indirectOwners) {
                    if (own.crd && own.legalName) {
                        const cid = String(own.crd);
                        if (genericMap.has(cid) && !genericMap.get(cid).name) {
                            genericMap.get(cid).name = own.legalName;
                            foundCount++;
                        }
                    }
                }
            }
            // Previous IA employments
            if (content.previousIAEmployments) {
                for (const emp of content.previousIAEmployments) {
                    if (emp.firmId && emp.firmName) {
                        const fid = String(emp.firmId);
                        if (genericMap.has(fid) && !genericMap.get(fid).name) {
                            genericMap.get(fid).name = emp.firmName;
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

console.log("Scanning FINRA raw...");
scanDir(rawDir1);
console.log("Scanning SEC raw...");
scanDir(rawDir2);

console.log(`Found names for ${foundCount} generic entities.`);

const out = fs.createWriteStream(outCsvPath);
out.write(header + '\n');
for (const [crd, val] of genericMap.entries()) {
    let safeName = (val.name || '').replace(/"/g, '""');
    out.write(`${val.type},${crd},"${safeName}",false,false,false\n`);
}
out.end();
console.log(`Wrote updated file to ${outCsvPath}`);
