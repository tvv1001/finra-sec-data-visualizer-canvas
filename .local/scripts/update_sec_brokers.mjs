console.error('update_sec_brokers.mjs is retired. Firm rosters live only in Redis firm-connections:firm:<id>. Do not write finra/sec:firm:*_brokers:* keys.');
process.exit(1);

import fetch from 'node-fetch';
import Redis from 'ioredis';

const redis = new Redis();

function toArraySafe(v) {
	return Array.isArray(v) ? v : [];
}

async function updateSecBrokers(firmId) {
    const url = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious=true&wt=json`;
    console.log(`Fetching ${url}...`);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
        console.error(`Failed to fetch ${url}: ${res.statusText}`);
        return;
    }
    const data = await res.json();
    const hits = data?.hits?.hits || [];
    console.log(`Found ${hits.length} hits for firm ${firmId}.`);
    
    const connected = new Set();
    const previous = new Set();
    
    for (const hit of hits) {
        const src = hit._source || {};
        const crd = String(src.ind_source_id || src.ind_crd || src.individualId || src.id);
        if (!crd) continue;
        
        // Use ind_ia_current_employments for connected
        const currentIA = [
            ...(hit.inner_hits?.ind_ia_current_employments?.hits?.hits?.map((h) => h._source) || []),
            ...toArraySafe(src.ind_ia_current_employments)
        ];
        if (currentIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            connected.add(crd);
        }
        
        // Use ind_previous_employments for previous
        const previousIA = [
            ...(hit.inner_hits?.ind_previous_employments?.hits?.hits?.map((h) => h._source) || []),
            ...toArraySafe(src.ind_previous_employments)
        ];
        if (previousIA.some(e => String(e.firmId || e.firm_id) === String(firmId))) {
            previous.add(crd);
        }
    }
    
    console.log(`Firm ${firmId}: ${connected.size} connected, ${previous.size} previous.`);
    
    // update redis
    await redis.set(`sec:firm:${firmId}_brokers:current`, JSON.stringify(Array.from(connected)));
    await redis.set(`sec:firm:${firmId}_brokers:previous`, JSON.stringify(Array.from(previous)));
}

async function run() {
    const args = process.argv.slice(2);
    const firms = args.length > 0 ? args : ['10028'];
    for (const firm of firms) {
        await updateSecBrokers(firm);
    }
    redis.disconnect();
}

run().catch(console.error);
