import Redis from 'ioredis';

const client = new Redis('redis://127.0.0.1:6379');

async function isCrdLive(type, crd) {
    const url = `http://127.0.0.1:4444/api/finra/${type}/${crd}?merged=1`;
    try {
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            // A CRD is live if it has valid FINRA or SEC data (not just an orphan shell)
            if (data.hasFinraData || data.hasSecData) {
                return true;
            }
        }
    } catch (e) {
        console.error(`Local API error for ${type} ${crd}:`, e.message);
    }
    
    return false;
}

async function run() {
    console.log("Fetching non-live-crds keys from local Redis...");
    let cursor = '0';
    const nonLiveKeys = [];
    do {
        const res = await client.scan(cursor, 'MATCH', 'non-live-crds:*', 'COUNT', 1000);
        cursor = res[0];
        nonLiveKeys.push(...res[1]);
    } while (cursor !== '0');
    
    console.log(`Found ${nonLiveKeys.length} non-live-crds keys in Redis.`);
    
    let deletedCount = 0;
    
    for (const key of nonLiveKeys) {
        const parts = key.split(':');
        if (parts.length < 3) continue;
        const type = parts[1];
        const crd = parts[2];
        
        const live = await isCrdLive(type, crd);
        if (live) {
            console.log(`❌ Key ${key} is actually LIVE via local API. Deleting from Redis...`);
            await client.del(key);
            deletedCount++;
        }
        
        // Small delay so we don't overwhelm the local API server
        await new Promise(r => setTimeout(r, 50));
    }
    
    console.log(`\nFinished. Deleted ${deletedCount} incorrectly categorized live CRDs.`);
    client.quit();
}

run().catch(console.error);
