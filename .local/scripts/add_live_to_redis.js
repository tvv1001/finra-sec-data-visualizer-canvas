const fs = require('fs');
const Redis = require('ioredis');

async function run() {
    const client = new Redis('redis://127.0.0.1:6379');
    
    // Clear any existing sets just in case
    await client.del('live-crds:firm');
    await client.del('live-crds:individual');
    
    const lines = fs.readFileSync('crd-list.csv', 'utf8').split('\n');
    
    let firmCount = 0;
    let indCount = 0;
    
    const firmBatch = [];
    const indBatch = [];
    
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const parts = lines[i].split(',');
        const type = parts[0];
        const crd = parts[1];
        
        if (type === 'firm') {
            firmBatch.push(crd);
            firmCount++;
            if (firmBatch.length >= 1000) {
                await client.sadd('live-crds:firm', ...firmBatch);
                firmBatch.length = 0;
            }
        } else if (type === 'individual') {
            indBatch.push(crd);
            indCount++;
            if (indBatch.length >= 1000) {
                await client.sadd('live-crds:individual', ...indBatch);
                indBatch.length = 0;
            }
        }
    }
    
    if (firmBatch.length > 0) await client.sadd('live-crds:firm', ...firmBatch);
    if (indBatch.length > 0) await client.sadd('live-crds:individual', ...indBatch);
    
    console.log(`Added ${firmCount} firms and ${indCount} individuals to Redis SETs.`);
    
    client.quit();
}
run();
