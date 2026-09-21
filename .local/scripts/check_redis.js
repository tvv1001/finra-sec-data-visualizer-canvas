const Redis = require('ioredis');
async function run() {
    const client = new Redis('redis://127.0.0.1:6379');
    let cursor = '0';
    let count = 0;
    do {
        const res = await client.scan(cursor, 'MATCH', 'sec:*', 'COUNT', 1000);
        cursor = res[0];
        count += res[1].length;
    } while (cursor !== '0');
    console.log("Total sec:*", count);
    client.quit();
}
run();
