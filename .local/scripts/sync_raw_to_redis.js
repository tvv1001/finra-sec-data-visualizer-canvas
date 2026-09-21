const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const zlib = require('zlib');

function compressPayload(raw) {
    if (!raw) return null;
    return 'br:' + zlib.brotliCompressSync(Buffer.from(raw, 'utf8')).toString('base64');
}

async function run() {
    const redis = new Redis('redis://127.0.0.1:6379');
    
    const lines = fs.readFileSync('crd-list.csv', 'utf8').split('\n');
    let finraCount = 0;
    let secCount = 0;
    
    console.log(`Syncing ${lines.length - 1} CRDs to Redis...`);
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const parts = line.match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
        if (!parts) continue;
        
        const type = parts[1];
        const crd = parts[2];
        const inFinra = parts[5] === 'true';
        const inSec = parts[6] === 'true';
        
        if (inFinra) {
            const fPath = `data/raw/brokercheck.finra.org/api.brokercheck.finra.org_search_${type}_${crd}.json`;
            if (fs.existsSync(fPath)) {
                const raw = fs.readFileSync(fPath, 'utf8');
                await redis.set(`finra:${type}:${crd}`, compressPayload(raw));
                finraCount++;
            }
        }
        
        if (inSec) {
            const sPath = `data/raw/adviserinfo.sec.gov/api.adviserinfo.sec.gov_search_${type}_${crd}.json`;
            if (fs.existsSync(sPath)) {
                const raw = fs.readFileSync(sPath, 'utf8');
                await redis.set(`sec:${type}:${crd}`, compressPayload(raw));
                secCount++;
            }
        }
        
        if (i % 5000 === 0) console.log(`Processed ${i} rows...`);
    }
    
    console.log(`Synced ${finraCount} FINRA keys and ${secCount} SEC keys to local Redis!`);
    await redis.quit();
}
run();
