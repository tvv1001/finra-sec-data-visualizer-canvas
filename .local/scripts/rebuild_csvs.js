const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const map = new Map(); // id -> { type, name, hasDetail, inFinra, inSec }

function getEntity(id, type) {
    id = String(id);
    if (!map.has(id)) {
        map.set(id, { type, crd: id, name: '', hasDetail: false, inFinra: false, inSec: false });
    }
    return map.get(id);
}

function setName(id, type, name) {
    if (!name) return;
    const ent = getEntity(id, type);
    if (!ent.name) ent.name = name;
}

// 1. Load from crd-inventory.json.gz
if (fs.existsSync('data/crd-inventory.json.gz')) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync('data/crd-inventory.json.gz')));
    if (data.firms) data.firms.forEach(id => getEntity(id, 'firm'));
    if (data.individuals) data.individuals.forEach(id => getEntity(id, 'individual'));
}

// 2. Load from search sidecars
function processSearchIndex(filename, type, source) {
    if (!fs.existsSync(filename)) return;
    const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    if (data.docs) {
        for (const doc of data.docs) {
            if (doc.hit) {
                const h = doc.hit;
                let crd = h.firm_id || h.firmId || h.ind_id || h.indId || h.ind_source_id || h.ind_crd;
                if (!crd) continue;
                
                let name = h.firm_name || h.firmName || h.ind_name || h.indName;
                if (!name && (h.ind_firstname || h.ind_lastname)) {
                    let parts = [];
                    if (h.ind_firstname) parts.push(h.ind_firstname);
                    if (h.ind_middlename) parts.push(h.ind_middlename);
                    if (h.ind_lastname) parts.push(h.ind_lastname);
                    name = parts.join(' ');
                }
                
                const ent = getEntity(crd, type);
                if (!ent.name && name) ent.name = name;
                ent.hasDetail = true;
                if (source === 'finra') ent.inFinra = true;
                if (source === 'sec') ent.inSec = true;
            }
        }
    }
}
processSearchIndex('data/national/search-index.finra.firm.json', 'firm', 'finra');
processSearchIndex('data/national/search-index.sec.firm.json', 'firm', 'sec');
processSearchIndex('data/national/search-index.finra.individual.json', 'individual', 'finra');
processSearchIndex('data/national/search-index.sec.individual.json', 'individual', 'sec');

// 3. Scan raw files to flag hasDetail and extract names
function scanRaw(dir, source) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const match = file.match(/_(firm|individual)_(\d+)\.json$/);
        if (!match) continue;
        const type = match[1];
        const crd = match[2];
        const ent = getEntity(crd, type);
        ent.hasDetail = true;
        if (source === 'finra') ent.inFinra = true;
        if (source === 'sec') ent.inSec = true;
        
        // if it doesn't have a name, parse to find it
        if (!ent.name) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                if (data.hits && data.hits.hits && data.hits.hits[0] && data.hits.hits[0]._source) {
                    const content = JSON.parse(data.hits.hits[0]._source.content);
                    if (type === 'firm' && content.basicInformation && content.basicInformation.legalName) {
                        ent.name = content.basicInformation.legalName;
                    }
                }
            } catch(e) {}
        }
        
        // extract other names from employments/owners
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            if (data.hits && data.hits.hits && data.hits.hits[0] && data.hits.hits[0]._source) {
                const content = JSON.parse(data.hits.hits[0]._source.content);
                ['previousEmployments', 'currentEmployments', 'previousIAEmployments', 'currentIAEmployments'].forEach(k => {
                    if (content[k]) content[k].forEach(emp => {
                        if (emp.firmId && emp.firmName) setName(emp.firmId, 'firm', emp.firmName);
                    });
                });
                ['directOwners', 'indirectOwners'].forEach(k => {
                    if (content[k]) content[k].forEach(own => {
                        if (own.crd && own.legalName) setName(own.crd, 'individual', own.legalName);
                    });
                });
            }
        } catch(e) {}
    }
}
scanRaw('data/raw/brokercheck.finra.org', 'finra');
scanRaw('data/raw/adviserinfo.sec.gov', 'sec');

// 4. Scan firm-connections for more names
const fcDir = 'data/firm-connections';
if (fs.existsSync(fcDir)) {
    for (const file of fs.readdirSync(fcDir)) {
        if (!file.endsWith('.json')) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(fcDir, file), 'utf8'));
            ['currentConnections', 'previousConnections'].forEach(k => {
                if (data[k]) data[k].forEach(conn => {
                    if (conn.individualId && conn.name) setName(conn.individualId, 'individual', conn.name);
                });
            });
        } catch(e) {}
    }
}

// 5. Write outputs
const outDetail = fs.createWriteStream('crd-list.csv');
const outGeneric = fs.createWriteStream('crd-list-generic.csv');
const header = 'Type,CRD,Name,Has_Detail_Page,In_FINRA,In_SEC\n';
outDetail.write(header);
outGeneric.write(header);

for (const val of map.values()) {
    let safeName = (val.name || '').replace(/"/g, '""');
    const line = `${val.type},${val.crd},"${safeName}",${val.hasDetail},${val.inFinra},${val.inSec}\n`;
    if (val.hasDetail) {
        outDetail.write(line);
    } else {
        outGeneric.write(line);
    }
}
outDetail.end();
outGeneric.end();
console.log("Done rebuild.");
