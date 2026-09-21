const Redis = require('ioredis');
const zlib = require('zlib');

async function run() {
    const client = new Redis('redis://127.0.0.1:6379');
    const data = await client.get('non-live-crds:individual:6597789');
    if (data && data.startsWith('br:')) {
        const b64 = data.substring(3);
        const buf = Buffer.from(b64, 'base64');
        const uncompressed = zlib.brotliDecompressSync(buf).toString();
        console.log("Decoded:", JSON.stringify(JSON.parse(uncompressed), null, 2));
    }
    client.quit();
}
run();
