const fs = require('fs');
const zlib = require('zlib');

function processSearchIndex(filename, map, type, source) {
  if (!fs.existsSync(filename)) return;
  console.log(`Reading ${filename}...`);
  try {
      const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
      if (data && data.docs) {
          for (const doc of data.docs) {
              if (doc.hit) {
                  let crd = doc.hit.firm_id || doc.hit.firmId || doc.hit.ind_id || doc.hit.indId || doc.hit.ind_source_id || doc.hit.ind_crd;
                  
                  let name = doc.hit.firm_name || doc.hit.firmName || doc.hit.ind_name || doc.hit.indName;
                  if (!name && (doc.hit.ind_firstname || doc.hit.ind_lastname)) {
                      let parts = [];
                      if (doc.hit.ind_firstname) parts.push(doc.hit.ind_firstname);
                      if (doc.hit.ind_middlename) parts.push(doc.hit.ind_middlename);
                      if (doc.hit.ind_lastname) parts.push(doc.hit.ind_lastname);
                      name = parts.join(' ');
                  }
                  
                  if (crd) {
                      crd = String(crd);
                      if (!map.has(crd)) {
                          map.set(crd, { 
                              type: type, 
                              crd: crd, 
                              name: name, 
                              inFinra: source === 'finra', 
                              inSec: source === 'sec' 
                          });
                      } else {
                          let existing = map.get(crd);
                          if (!existing.name && name) {
                              existing.name = name;
                          }
                          if (source === 'finra') existing.inFinra = true;
                          if (source === 'sec') existing.inSec = true;
                      }
                  }
              }
          }
      }
  } catch(e) {
      console.error("Error parsing", filename, e.message);
  }
}

function processInventory(filename, map) {
    if (!fs.existsSync(filename)) return;
    console.log(`Reading ${filename}...`);
    try {
        const buffer = fs.readFileSync(filename);
        const jsonStr = zlib.gunzipSync(buffer).toString('utf-8');
        const data = JSON.parse(jsonStr);
        
        if (data.firms) {
            for (let id of data.firms) {
                id = String(id);
                if (!map.has(id)) {
                    map.set(id, { type: 'firm', crd: id, name: '', inFinra: false, inSec: false });
                }
            }
        }
        
        if (data.individuals) {
            for (let id of data.individuals) {
                id = String(id);
                if (!map.has(id)) {
                    map.set(id, { type: 'individual', crd: id, name: '', inFinra: false, inSec: false });
                }
            }
        }
    } catch(e) {
        console.error("Error parsing inventory", filename, e.message);
    }
}

function run() {
  const map = new Map();
  processSearchIndex('data/national/search-index.finra.firm.json', map, 'firm', 'finra');
  processSearchIndex('data/national/search-index.sec.firm.json', map, 'firm', 'sec');
  processSearchIndex('data/national/search-index.finra.individual.json', map, 'individual', 'finra');
  processSearchIndex('data/national/search-index.sec.individual.json', map, 'individual', 'sec');
  
  processInventory('data/crd-inventory.json.gz', map);

  console.log(`Found ${map.size} unique entities.`);
  
  const outPath = 'crd-list.csv';
  const out = fs.createWriteStream(outPath);
  out.write('Type,CRD,Name,Has_Detail_Page,In_FINRA,In_SEC\n');
  
  for (const val of map.values()) {
      let safeName = (val.name || '').replace(/"/g, '""');
      let hasDetail = val.inFinra || val.inSec;
      out.write(`${val.type},${val.crd},"${safeName}",${hasDetail},${val.inFinra},${val.inSec}\n`);
  }
  out.end();
  console.log(`Wrote to ${outPath}`);
}

run();
