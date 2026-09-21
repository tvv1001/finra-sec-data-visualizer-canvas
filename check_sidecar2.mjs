import fs from 'fs';
import zlib from 'zlib';

const crds = ['283003', '32241', '329502', '337307', '7603', '37042', '285252', '165127', '14052', '151428', '157210', '140470', '171898', '172470'];
function checkFile(filename) {
  try {
    if (!fs.existsSync(filename)) return;
    const buf = fs.readFileSync(filename);
    const json = JSON.parse(zlib.gunzipSync(buf).toString('utf-8'));
    const crdSet = new Set(crds);
    const found = [];
    for (const doc of (json.docs || [])) {
      const hit = doc.hit || {};
      if (crdSet.has(String(hit.crd || hit.firm_id))) {
        found.push(hit);
      }
    }
    console.log(`File ${filename}: found ${found.length} matches`);
  } catch (err) {
    console.error(err);
  }
}
checkFile('public/search-indexes/search-index.finra.firm.json.gz');
checkFile('public/search-indexes/search-index.sec.firm.json.gz');
