#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const ROOT = process.cwd();
const EXTERNAL = path.join(ROOT, 'data', 'external');
const FINRA = path.join(ROOT, 'data', 'national', 'brokercheck.finra.org');
const SEC = path.join(ROOT, 'data', 'national', 'adviserinfo.sec.gov');

async function main() {
  const report = { total: 0, parsed: 0, errors: [] };
  const folders = [EXTERNAL, FINRA, SEC];
  for (const folder of folders) {
    try {
      const files = await fs.readdir(folder);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(folder, f);
        report.total++;
        try {
          const txt = await fs.readFile(p, 'utf-8');
          if (!txt || !txt.trim()) throw new Error('empty file');
          JSON.parse(txt);
          report.parsed++;
        } catch (e) {
          report.errors.push({ file: p, error: String(e.message || e) });
        }
      }
    } catch (e) {
      // ignore missing folders
    }
  }
  try { await fs.mkdir(path.join(ROOT, 'data'), { recursive: true }); } catch {}
  await fs.writeFile(path.join(ROOT, 'data', 'last_integrity_report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log('Wrote data/last_integrity_report.json');
  console.log('Summary:', report.total, 'files, parsed=', report.parsed, 'errors=', report.errors.length);
  if (report.errors.length) console.log('First error sample:', report.errors[0]);
}

main().catch(e => { console.error(e); process.exit(1); });
