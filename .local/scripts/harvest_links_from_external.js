#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const NATIONAL = path.join(DATA_DIR, 'national');
const SEC_DIR = path.join(NATIONAL, 'adviserinfo.sec.gov');
const FINRA_DIR = path.join(NATIONAL, 'brokercheck.finra.org');
const EXTERNAL_DIR = path.join(DATA_DIR, 'external');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)', Accept: 'application/json' };

function finraFirmUrl(id) { return `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&wt=json`; }
function finraIndividualUrl(id) { return `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`; }
function secFirmUrl(id) { return `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(id)}&hl=true&nrows=12&start=0&wt=json`; }
function secIndividualUrl(id) { return `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`; }

async function readJsonSafe(file) { try { return JSON.parse(await fs.readFile(file, 'utf-8')); } catch { return null; } }

async function fetchAndSave(url, outExternal, outNationalPath) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const raw = JSON.stringify(data, null, 2);
    if (outExternal) await fs.writeFile(path.join(EXTERNAL_DIR, outExternal), raw, 'utf-8');
    if (outNationalPath) await fs.writeFile(outNationalPath, raw, 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

async function harvest() {
  await fs.mkdir(EXTERNAL_DIR, { recursive: true });
  await fs.mkdir(SEC_DIR, { recursive: true });
  await fs.mkdir(FINRA_DIR, { recursive: true });

  const foundF = new Set();
  const foundI = new Set();

  const files = await fs.readdir(EXTERNAL_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const j = await readJsonSafe(path.join(EXTERNAL_DIR, f));
    if (!j) continue;
    // look for directOwners
    try {
      if (j.directOwners && Array.isArray(j.directOwners)) {
        for (const o of j.directOwners) {
          if (o.ownerFirmId) foundF.add(String(o.ownerFirmId));
          if (o.ownerId) foundI.add(String(o.ownerId));
        }
      }
    } catch {}
    // try content field
    try {
      const c = j.content && (typeof j.content === 'string' ? JSON.parse(j.content) : j.content);
      if (c) {
        if (Array.isArray(c.currentEmployments)) for (const e of c.currentEmployments) if (e.firmId) foundF.add(String(e.firmId));
        if (Array.isArray(c.previousEmployments)) for (const e of c.previousEmployments) if (e.firmId) foundF.add(String(e.firmId));
        if (c.basicInformation && (c.basicInformation.crd || c.basicInformation.individualId)) foundI.add(String(c.basicInformation.crd || c.basicInformation.individualId));
      }
    } catch {}
    // generic keys
    try {
      if (j.ind_current_employments) for (const e of j.ind_current_employments) if (e.firmId) foundF.add(String(e.firmId));
      if (j.ind_previous_employments) for (const e of j.ind_previous_employments) if (e.firmId) foundF.add(String(e.firmId));
      if (j.firm_id) foundF.add(String(j.firm_id));
      if (j.firmId) foundF.add(String(j.firmId));
      if (j.ind_source_id) foundI.add(String(j.ind_source_id));
    } catch {}
  }

  console.log('Harvest discovered', foundF.size, 'firm ids and', foundI.size, 'individual ids');

  // fetch missing
  let fetched = 0;
  for (const fid of foundF) {
    const outPath = path.join(FINRA_DIR, `firm_${fid}.json`);
    const secPath = path.join(SEC_DIR, `sec_${fid}.json`);
    if (!(await exists(outPath))) {
      const ok = await fetchAndSave(finraFirmUrl(fid), `finra_firm_${fid}.json`, outPath);
      if (ok) fetched++;
      await delay(150);
    }
    if (!(await exists(secPath))) {
      const ok2 = await fetchAndSave(secFirmUrl(fid), `sec_firm_${fid}.json`, secPath);
      if (ok2) fetched++;
      await delay(150);
    }
  }
  for (const iid of foundI) {
    const outPath = path.join(FINRA_DIR, `individual_${iid}.json`);
    const secPath = path.join(SEC_DIR, `sec_${iid}.json`);
    if (!(await exists(outPath))) {
      const ok = await fetchAndSave(finraIndividualUrl(iid), `finra_individual_${iid}.json`, outPath);
      if (ok) fetched++;
      await delay(150);
    }
    if (!(await exists(secPath))) {
      const ok2 = await fetchAndSave(secIndividualUrl(iid), `sec_individual_${iid}.json`, secPath);
      if (ok2) fetched++;
      await delay(150);
    }
  }

  console.log('Harvest fetch complete. fetched=', fetched);
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (require.main === module) harvest().catch((e) => { console.error(e); process.exit(1); });
