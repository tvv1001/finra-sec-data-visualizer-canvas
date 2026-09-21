const fs = require('fs');
const path = require('path');

const list1 = 'crd-list.csv';
const lines = fs.readFileSync(list1, 'utf8').split('\n');
const header = lines[0];

const rawDir1 = 'data/raw/brokercheck.finra.org';
const rawDir2 = 'data/raw/adviserinfo.sec.gov';

let liveCount = 0;
let movedCount = 0;

const outLive = fs.createWriteStream('crd-list-actual-live.csv');
outLive.write(header + '\n');
const outGeneric = fs.createWriteStream('crd-list-generic-append.csv');

for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    const type = parts[0];
    const crd = parts[1];
    
    const file1 = path.join(rawDir1, `api.brokercheck.finra.org_search_${type}_${crd}.json`);
    const file2 = path.join(rawDir2, `api.adviserinfo.sec.gov_search_${type}_${crd}.json`);
    
    if (fs.existsSync(file1) || fs.existsSync(file2)) {
        outLive.write(line + '\n');
        liveCount++;
    } else {
        // Change Has_Detail_Page from true to false
        const newLine = line.replace(/,true,(true|false),(true|false)$/, ',false,$1,$2');
        outGeneric.write(newLine + '\n');
        movedCount++;
    }
}
outLive.end();
outGeneric.end();
console.log(`Live (has raw file): ${liveCount}. Moved to generic: ${movedCount}`);
