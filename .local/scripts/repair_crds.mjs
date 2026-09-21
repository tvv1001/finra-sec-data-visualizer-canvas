import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import IORedis from 'ioredis';
import { hasFirmSourceCoverage, hasIndividualSourceCoverage } from '../../src/lib/sourceTruth.ts';

const redis = new IORedis('redis://127.0.0.1:6379');

const invBuf = fsSync.readFileSync('data/crd-inventory.json.gz');
const inventory = JSON.parse(zlib.gunzipSync(invBuf).toString('utf8'));

const people = new Set(inventory.individuals.map(String));
const firms = new Set(inventory.firms.map(String));

const nationalFinra = 'data/national/brokercheck.finra.org';
const nationalSec = 'data/national/adviserinfo.sec.gov';

async function getDiskCrds(dir, entity) {
    const set = new Set();
    try {
        const files = await fs.readdir(dir);
        for (const file of files) {
            const m = file.match(new RegExp(`_search_${entity}_(\\d+)\\.json$`));
            if (m) set.add(m[1]);
        }
    } catch (e) {}
    return set;
}

const diskIndsFinra = await getDiskCrds(nationalFinra, 'individual');
const diskIndsSec = await getDiskCrds(nationalSec, 'individual');
const diskFirmsFinra = await getDiskCrds(nationalFinra, 'firm');
const diskFirmsSec = await getDiskCrds(nationalSec, 'firm');

const missingInds = [...people].filter(x => !diskIndsFinra.has(x) && !diskIndsSec.has(x));
const missingFirms = [...firms].filter(x => !diskFirmsFinra.has(x) && !diskFirmsSec.has(x));

console.log(`Starting repair... Missing Inds: ${missingInds.length}, Missing Firms: ${missingFirms.length}`);

async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function parseEmbedded(source) {
    if (!source) return null;
    for (const key of ['content', 'BrokerReport', 'IAPDReport']) {
        if (source[key]) {
            if (typeof source[key] === 'string') {
                try { return JSON.parse(source[key]); } catch {}
            }
            return source[key];
        }
    }
    return null;
}

async function processMissing(crd, kind) {
    const isFirm = kind === 'firm';
    const finraUrl = `https://api.brokercheck.finra.org/search/${kind}/${crd}?hl=true&includePrevious=true&wt=json`;
    const secUrl = `https://api.adviserinfo.sec.gov/search/${kind}/${crd}?hl=true&includePrevious=true&wt=json`;

    let finraData = null, secData = null;
    try { finraData = await fetchJson(finraUrl); } catch {}
    try { secData = await fetchJson(secUrl); } catch {}

    const finraHits = finraData?.hits?.hits || [];
    const secHits = secData?.hits?.hits || [];

    const finraValid = finraHits.length > 0 && (isFirm ? hasFirmSourceCoverage(finraHits[0]._source, 'finra') : hasIndividualSourceCoverage(finraHits[0]._source, 'finra'));
    const secValid = secHits.length > 0 && (isFirm ? hasFirmSourceCoverage(secHits[0]._source, 'sec') : hasIndividualSourceCoverage(secHits[0]._source, 'sec'));

    if (!finraValid && !secValid) {
        console.log(`Junk CRD detected: ${crd} (${kind}) - No valid details page found. Removing from inventory/redis...`);
        // Remove from inventory arrays
        if (isFirm) {
            inventory.firms = inventory.firms.filter(x => String(x) !== crd);
            await redis.del(`finra:firm:${crd}`, `sec:firm:${crd}`);
        } else {
            inventory.individuals = inventory.individuals.filter(x => String(x) !== crd);
            await redis.del(`finra:individual:${crd}`, `sec:individual:${crd}`);
        }
        return false;
    }

    if (finraValid) {
        const file = `data/national/brokercheck.finra.org/api.brokercheck.finra.org_search_${kind}_${crd}.json`;
        await fs.writeFile(file, JSON.stringify(finraData, null, 2));
        await redis.set(`finra:${kind}:${crd}`, JSON.stringify(finraData));
    }

    if (secValid) {
        const file = `data/national/adviserinfo.sec.gov/api.adviserinfo.sec.gov_search_${kind}_${crd}.json`;
        await fs.writeFile(file, JSON.stringify(secData, null, 2));
        await redis.set(`sec:${kind}:${crd}`, JSON.stringify(secData));
    }
    
    console.log(`Repaired ${crd} (${kind}) - FINRA: ${finraValid}, SEC: ${secValid}`);
    return true;
}

async function run() {
    let count = 0;
    // Process only first 50 to avoid taking too long for now, unless instructed to do all.
    const subsetInds = missingInds.slice(0, 10);
    const subsetFirms = missingFirms.slice(0, 10);

    for (const crd of subsetInds) {
        await processMissing(crd, 'individual');
        await new Promise(r => setTimeout(r, 250));
        count++;
    }
    for (const crd of subsetFirms) {
        await processMissing(crd, 'firm');
        await new Promise(r => setTimeout(r, 250));
        count++;
    }
    
    // Write updated inventory back if we modified it
    const updatedGz = zlib.gzipSync(JSON.stringify(inventory));
    await fs.writeFile('data/crd-inventory.json.gz', updatedGz);
    
    console.log(`Processed ${count} CRDs.`);
    process.exit(0);
}

run();
