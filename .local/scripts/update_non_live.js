const fs = require('fs');
const zlib = require('zlib');
const Redis = require('ioredis');

const list1 = 'crd-list.csv';
const list2 = 'crd-list-generic.csv';

const map = new Map();

function loadCSV(filename) {
    if (!fs.existsSync(filename)) return;
    const lines = fs.readFileSync(filename, 'utf8').split('\n');
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const match = line.match(/^([^,]+),([^,]+),"([^"]*)",(false|true),(false|true),(false|true)$/);
        if (match) {
            const crd = match[2];
            map.set(crd, {
                type: match[1],
                crd: crd,
                name: match[3],
                hasDetail: match[4] === 'true',
                inFinra: match[5] === 'true',
                inSec: match[6] === 'true'
            });
        }
    }
}

loadCSV(list1);
loadCSV(list2);

async function run() {
    const client = new Redis('redis://127.0.0.1:6379');
    let cursor = '0';
    const nonLiveKeys = [];
    do {
        const res = await client.scan(cursor, 'MATCH', 'non-live-crds:*', 'COUNT', 1000);
        cursor = res[0];
        nonLiveKeys.push(...res[1]);
    } while (cursor !== '0');
    
    console.log(`Found ${nonLiveKeys.length} non-live-crds keys in Redis.`);
    
    for (const key of nonLiveKeys) {
        try {
            const data = await client.get(key);
            if (data && data.startsWith('br:')) {
                const b64 = data.substring(3);
                const buf = Buffer.from(b64, 'base64');
                const uncompressed = zlib.brotliDecompressSync(buf).toString();
                const json = JSON.parse(uncompressed);
                
                if (json.orphan) {
                    const crd = json.orphan.crd || json.crd;
                    // determine type from key: non-live-crds:firm:123 or non-live-crds:individual:123
                    const type = key.split(':')[1];
                    const name = json.orphan.name || json.orphan.legalName || json.orphan.firmName || '';
                    
                    if (crd) {
                        if (!map.has(crd)) {
                            map.set(crd, { type, crd, name: name, hasDetail: false, inFinra: false, inSec: false });
                        } else {
                            const entry = map.get(crd);
                            if (!entry.name) entry.name = name;
                            entry.hasDetail = false; // Force generic
                            entry.inFinra = false;
                            entry.inSec = false;
                        }
                    }
                }
            }
        } catch(e) {
            console.error(`Error processing key ${key}: ${e.message}`);
        }
    }
    
    client.quit();
    
    const out1 = fs.createWriteStream(list1);
    const out2 = fs.createWriteStream(list2);
    const header = 'Type,CRD,Name,Has_Detail_Page,In_FINRA,In_SEC\n';
    out1.write(header);
    out2.write(header);
    
    let detailCount = 0;
    let genericCount = 0;

    for (const val of map.values()) {
        let safeName = (val.name || '').replace(/"/g, '""');
        const line = `${val.type},${val.crd},"${safeName}",${val.hasDetail},${val.inFinra},${val.inSec}\n`;
        if (val.hasDetail) {
            out1.write(line);
            detailCount++;
        } else {
            out2.write(line);
            genericCount++;
        }
    }
    out1.end();
    out2.end();
    
    console.log(`Updated CSVs! Detail: ${detailCount}, Generic: ${genericCount}`);
}

run();
