const fs = require('fs');
const path = require('path');

const listPath = 'crd-list.csv';
const lines = fs.readFileSync(listPath, 'utf8').split('\n');

const out = fs.createWriteStream('crd-list-fixed.csv');
out.write(lines[0] + '\n');

let fixedCount = 0;

for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
    if (!parts) continue;
    
    const type = parts[1];
    const crd = parts[2];
    let name = parts[3];
    const rest = `${parts[4]},${parts[5]},${parts[6]}`;
    
    if (!name) {
        const p1 = `data/raw/brokercheck.finra.org/api.brokercheck.finra.org_search_${type}_${crd}.json`;
        const p2 = `data/raw/adviserinfo.sec.gov/api.adviserinfo.sec.gov_search_${type}_${crd}.json`;
        
        for (const f of [p1, p2]) {
            if (fs.existsSync(f)) {
                try {
                    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
                    if (data.hits && data.hits.hits && data.hits.hits[0] && data.hits.hits[0]._source) {
                        const content = JSON.parse(data.hits.hits[0]._source.content);
                        if (content.basicInformation) {
                            if (type === 'firm' && content.basicInformation.firmName) {
                                name = content.basicInformation.firmName;
                            }
                        }
                    }
                } catch(e) {}
            }
            if (name) break;
        }
        if (name) fixedCount++;
    }
    
    let safeName = (name || '').replace(/"/g, '""');
    out.write(`${type},${crd},"${safeName}",${rest}\n`);
}
out.end();
console.log(`Fixed ${fixedCount} names!`);
