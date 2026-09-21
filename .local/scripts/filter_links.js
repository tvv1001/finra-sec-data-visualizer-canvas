const fs = require('fs');

const liveCRDs = new Set();
const lines = fs.readFileSync('crd-list.csv', 'utf8').split('\n');
for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^([^,]+),([^,]+),/);
    if (match) {
        liveCRDs.add(match[2]);
    }
}

const inLines = fs.readFileSync('non-live-crds-from-live-crd-detail-pages.csv', 'utf8').split('\n');
const out = fs.createWriteStream('non-live-crds-from-live-crd-detail-pages-filtered.csv');
out.write(inLines[0] + '\n');

let count = 0;
for (let i = 1; i < inLines.length; i++) {
    if (!inLines[i]) continue;
    const parts = inLines[i].split(',');
    const crd = parts[1];
    if (!liveCRDs.has(crd)) {
        out.write(inLines[i] + '\n');
        count++;
    }
}
out.end();
console.log(`Filtered to ${count} non-live CRDs.`);
