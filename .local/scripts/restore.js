const fs = require('fs');
const Redis = require('ioredis');
const zlib = require('zlib');

async function restore() {
    const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    // We will use standard ioredis instead of fetch if we can, but Upstash REST is HTTP.
    // However, if we just want to POST the graph using fetch:
    const graphStr = fs.readFileSync('data/national/finra-graph.json', 'utf8');
    const graphJson = JSON.parse(graphStr);
    
    // Convert to gzip base64
    const gzipped = zlib.gzipSync(graphStr);
    const b64 = gzipped.toString('base64');
    
    console.log(`Uploading graph of size ${b64.length} bytes...`);
    
    const res = await fetch(`${url}/set/graph:snapshot`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`
        },
        body: b64
    });
    
    console.log(await res.text());
    
    // Build seed bank
    let individuals = 0;
    let firms = 0;
    graphJson.nodes.forEach(n => {
        if (n.group === 'individual') individuals++;
        else if (n.group === 'firm') firms++;
    });
    
    const seedBank = {
        updatedAt: new Date().toISOString(),
        counts: {
            individuals,
            firms,
            entities: 0,
            others: 0,
            totalNodes: graphJson.nodes.length
        },
        seeds: graphJson.nodes.map(n => n.id)
    };
    
    const seedRes = await fetch(`${url}/set/graph:seed-bank`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(seedBank)
    });
    console.log(await seedRes.text());
    
    console.log("Done!");
}
restore();
