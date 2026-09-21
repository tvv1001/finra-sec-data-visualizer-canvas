const fs = require('fs');
const path = require('path');

const outPath = 'non-live-crds-from-live-crd-detail-pages.csv';
const out = fs.createWriteStream(outPath);
out.write('Extracted_Type,Extracted_CRD,Extracted_Name,Source_Type,Source_CRD\n');

const seen = new Set(); // to avoid exact duplicate rows if we want, or we can list every edge

function scanRaw(dir) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const match = file.match(/_(firm|individual)_(\d+)\.json$/);
        if (!match) continue;
        const srcType = match[1];
        const srcCrd = match[2];
        
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            if (data.hits && data.hits.hits && data.hits.hits[0] && data.hits.hits[0]._source) {
                const content = JSON.parse(data.hits.hits[0]._source.content);
                
                ['previousEmployments', 'currentEmployments', 'previousIAEmployments', 'currentIAEmployments'].forEach(k => {
                    if (content[k]) content[k].forEach(emp => {
                        if (emp.firmId) {
                            const extCrd = String(emp.firmId);
                            const name = (emp.firmName || '').replace(/"/g, '""');
                            const key = `firm,${extCrd},${srcType},${srcCrd}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                out.write(`firm,${extCrd},"${name}",${srcType},${srcCrd}\n`);
                            }
                        }
                    });
                });
                
                ['directOwners', 'indirectOwners'].forEach(k => {
                    if (content[k]) content[k].forEach(own => {
                        if (own.crd) {
                            const extCrd = String(own.crd);
                            const name = (own.legalName || '').replace(/"/g, '""');
                            const key = `individual,${extCrd},${srcType},${srcCrd}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                out.write(`individual,${extCrd},"${name}",${srcType},${srcCrd}\n`);
                            }
                        }
                    });
                });
            }
        } catch(e) {}
    }
}

scanRaw('data/raw/brokercheck.finra.org');
scanRaw('data/raw/adviserinfo.sec.gov');

out.end();
console.log("Done writing links!");
