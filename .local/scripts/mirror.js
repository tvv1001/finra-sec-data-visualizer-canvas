const { Redis } = require('@upstash/redis');

async function run() {
    const db1 = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    
    const db2 = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL_MIRROR,
        token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR,
    });
    
    console.log("Starting DB1 to DB2 mirror process...");
    
    let cursor = 0;
    let totalCopied = 0;
    
    do {
        const [nextCursor, keys] = await db1.scan(cursor, { match: '*', count: 100 });
        cursor = nextCursor;
        
        if (keys.length > 0) {
            // Get all values from db1
            const values = await db1.mget(...keys);
            
            // Set all values in db2
            const pipeline = db2.pipeline();
            for (let i = 0; i < keys.length; i++) {
                if (values[i] !== null) {
                    if (typeof values[i] === 'object') {
                        pipeline.set(keys[i], JSON.stringify(values[i]));
                    } else {
                        pipeline.set(keys[i], values[i]);
                    }
                }
            }
            await pipeline.exec();
            totalCopied += keys.length;
            console.log(`Copied ${totalCopied} keys...`);
        }
    } while (cursor !== 0 && cursor !== '0');
    
    console.log("Done syncing DB1 to DB2! Total keys:", totalCopied);
}

run().catch(console.error);
