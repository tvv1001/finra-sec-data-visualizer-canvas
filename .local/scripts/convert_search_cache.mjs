import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);

async function run() {
    const raw = await fs.readFile('public/search-indexes/node-search-cache.json', 'utf8');
    const nodes = JSON.parse(raw);
    
    const buckets = {
        'finra:individual': [],
        'finra:firm': [],
        'sec:individual': [],
        'sec:firm': []
    };
    
    for (const node of nodes) {
        // node is { crd: "...", label: "...", type: "individual" | "firm" }
        // Assume finra for all if source is not specified, or duplicate for sec.
        // Actually, let's just put everything in finra for now to fix the search.
        const type = node.type === 'firm' ? 'firm' : 'individual';
        buckets[`finra:${type}`].push({
            id: `finra:${type}:${node.crd}`,
            hit: {
                id: `finra:${type}:${node.crd}`,
                crd: node.crd,
                label: node.label,
                type: type,
                source: 'finra'
            }
        });
    }
    
    for (const [bucket, docs] of Object.entries(buckets)) {
        if (docs.length === 0) continue;
        const payload = {
            generatedAt: new Date().toISOString(),
            bucket,
            docs
        };
        const fileName = `search-index.${bucket.replace(':', '.')}.json.gz`;
        const dest = path.join('public', 'search-indexes', fileName);
        
        const compressed = await gzip(JSON.stringify(payload));
        await fs.writeFile(dest, compressed);
        console.log(`Wrote ${docs.length} docs to ${dest}`);
    }
}

run().catch(console.error);
