import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';

const local = new Redis('redis://127.0.0.1:6379');
const db1 = new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const db2 = new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL_MIRROR, token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR });

async function main() {
  console.log('Scanning local Redis for keys...');
  let cursor = '0';
  const keys = [];
  do {
    const [nextCursor, batch] = await local.scan(cursor, 'MATCH', '*');
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  console.log(`Found ${keys.length} keys in local Redis. Reading and pushing in batches of 100...`);

  const chunkSize = 100;
  let pushed = 0;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const batchKeys = keys.slice(i, i + chunkSize);
    const values = await local.mget(...batchKeys);

    const msetObj = {};
    for (let j = 0; j < batchKeys.length; j++) {
      if (values[j] !== null) {
        msetObj[batchKeys[j]] = values[j];
      }
    }

    const keyCount = Object.keys(msetObj).length;
    if (keyCount > 0) {
      await db1.mset(msetObj);
      await db2.mset(msetObj);
      pushed += keyCount;
      console.log(`Pushed batch of ${keyCount} keys... (${pushed}/${keys.length})`);
    }
  }

  console.log(`\nSuccessfully pushed ${pushed} keys to both DB1 and DB2.`);
  process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
