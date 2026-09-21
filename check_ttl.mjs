import Redis from 'ioredis';
const r = new Redis('redis://127.0.0.1:6379');
const keys = await r.keys('*');
let hasTtl = false;
for (const k of keys.slice(0, 100)) {
  const ttl = await r.ttl(k);
  if (ttl > 0) hasTtl = true;
}
console.log('Has TTL:', hasTtl);
process.exit(0);
