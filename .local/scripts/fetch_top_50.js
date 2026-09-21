const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function fetchAndSave(type, crd) {
    const finraUrl = `https://api.brokercheck.finra.org/search/${type}/${crd}?hl=true&includePrevious=true&wt=json`;
    const secUrl = `https://api.adviserinfo.sec.gov/search/${type}/${crd}?hl=true&includePrevious=true&wt=json`;

    const finraPath = path.join(__dirname, `data/raw/brokercheck.finra.org/api.brokercheck.finra.org_search_${type}_${crd}.json`);
    const secPath = path.join(__dirname, `data/raw/adviserinfo.sec.gov/api.adviserinfo.sec.gov_search_${type}_${crd}.json`);

    try {
        const finraRes = await fetch(finraUrl);
        if (finraRes.ok) {
            fs.mkdirSync(path.dirname(finraPath), { recursive: true });
            fs.writeFileSync(finraPath, await finraRes.text());
        }
    } catch (e) { }

    try {
        const secRes = await fetch(secUrl);
        if (secRes.ok) {
            fs.mkdirSync(path.dirname(secPath), { recursive: true });
            fs.writeFileSync(secPath, await secRes.text());
        }
    } catch (e) { }
}

async function run() {
    const lines = execSync('tail -n +2 crd-list.csv | sort -t, -k2,2nr | head -n 50').toString().split('\n').filter(Boolean);
    for (const line of lines) {
        const parts = line.split(',');
        const type = parts[0];
        const crd = parts[1];
        await fetchAndSave(type, crd);
    }
    console.log('Done!');
}
run();
