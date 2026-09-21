const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Redis = require('ioredis');
const zlib = require('zlib');

const RAW_DIR = {
    finra: 'data/raw/brokercheck.finra.org',
    sec: 'data/raw/adviserinfo.sec.gov'
};

const delay = ms => new Promise(res => setTimeout(res, ms));

function compressPayload(raw) {
    if (!raw) return null;
    return 'br:' + zlib.brotliCompressSync(Buffer.from(raw, 'utf8')).toString('base64');
}

async function fetchMissing(source, type, crd) {
    const url = source === 'finra'
        ? `https://api.brokercheck.finra.org/search/${type}/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`
        : `https://api.adviserinfo.sec.gov/search/${type}/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`;
        
    try {
        const res = await axios.get(url, { validateStatus: () => true });
        if (res.status === 200 && res.data && res.data.hits && res.data.hits.total > 0) {
            return JSON.stringify(res.data);
        }
    } catch(e) {
        console.error(`Error fetching ${source}:${type}:${crd}`, e.message);
    }
    return null;
}

async function run() {
    const redis = new Redis('redis://127.0.0.1:6379');
    const lines = fs.readFileSync('crd-list.csv', 'utf8').split('\n');
    
    console.log("Checking for missing host payloads...");
    let fetched = 0;
    
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const parts = lines[i].match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
        if (!parts) continue;
        
        const type = parts[1];
        const crd = parts[2];
        const inFinra = parts[5] === 'true';
        const inSec = parts[6] === 'true';
        
        let updated = false;
        
        // If we don't have SEC, try to fetch it
        if (!inSec) {
            const raw = await fetchMissing('sec', type, crd);
            if (raw) {
                const sPath = path.join(RAW_DIR.sec, `api.adviserinfo.sec.gov_search_${type}_${crd}.json`);
                fs.writeFileSync(sPath, raw);
                await redis.set(`sec:${type}:${crd}`, compressPayload(raw));
                parts[6] = 'true';
                updated = true;
                fetched++;
                console.log(`Fetched missing SEC page for ${crd}`);
                await delay(500); // polite delay
            } else {
                await delay(200);
            }
        }
        
        // If we don't have FINRA, try to fetch it
        if (!inFinra) {
            const raw = await fetchMissing('finra', type, crd);
            if (raw) {
                const fPath = path.join(RAW_DIR.finra, `api.brokercheck.finra.org_search_${type}_${crd}.json`);
                fs.writeFileSync(fPath, raw);
                await redis.set(`finra:${type}:${crd}`, compressPayload(raw));
                parts[5] = 'true';
                updated = true;
                fetched++;
                console.log(`Fetched missing FINRA page for ${crd}`);
                await delay(500); // polite delay
            } else {
                await delay(200);
            }
        }
        
        if (updated) {
            lines[i] = `${parts[1]},${parts[2]},"${parts[3]}",${parts[4]},${parts[5]},${parts[6]}`;
            // Periodically flush CSV to save progress
            if (fetched % 10 === 0) {
                fs.writeFileSync('crd-list.csv', lines.join('\n'));
            }
        }
    }
    
    fs.writeFileSync('crd-list.csv', lines.join('\n'));
    console.log(`Done! Fetched ${fetched} missing pages.`);
    redis.quit();
}
run();
