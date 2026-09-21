import IORedis from 'ioredis';
const redis = new IORedis('redis://127.0.0.1:6379');
const res = await redis.keys('*283003*');
console.log('Keys for 283003:', res);
for (const k of res) {
  const t = await redis.type(k);
  if (t === 'string') {
    const val = await redis.get(k);
    console.log(`Value for ${k}:`, val.substring(0, 100));
  }
}
process.exit(0);
