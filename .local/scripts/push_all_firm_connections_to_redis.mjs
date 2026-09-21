#!/usr/bin/env node
/*
 * Explicit, user-approved sync from local Redis to the app's production Upstash DBs.
 *
 * This script is intentionally conservative:
 * - no implicit writes
 * - no automatic production push
 * - default is dry-run
 * - actual push requires --confirm-prod-sync
 * - only touches Redis `firm-connections:firm:*` keys and never rewrites the app's local source of truth
 *
 * Usage examples:
 *   node scripts/push_all_firm_connections_to_redis.mjs --dry-run
 *   node scripts/push_all_firm_connections_to_redis.mjs --confirm-prod-sync --dry-run
 *   node scripts/push_all_firm_connections_to_redis.mjs --confirm-prod-sync --firm 7691
 */
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';

const args = new Set(process.argv.slice(2));
const confirm = args.has('--confirm-prod-sync');
const dryRun = args.has('--dry-run') || !confirm;
const limitFirm = (() => {
  const idx = process.argv.indexOf('--firm');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  return String(process.argv[idx + 1]).trim();
})();

if (!confirm) {
  console.error('Refusing to push to production Redis. Re-run with --confirm-prod-sync to perform an explicit, user-approved sync.');
  console.error('Safe preview: node scripts/push_all_firm_connections_to_redis.mjs --dry-run');
  process.exit(2);
}

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN environment variables.');
  process.exit(2);
}

const localRedis = new Redis('redis://127.0.0.1:6379');
const upstash = new UpstashRedis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const mirrorUrl = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
const mirrorToken = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;
const mirror = mirrorUrl && mirrorToken ? new UpstashRedis({ url: mirrorUrl, token: mirrorToken }) : null;

function matchFirmId(key) {
  const match = String(key || '').match(/^firm-connections:firm:(\d{1,10})$/);
  return match ? match[1] : null;
}

async function main() {
  const rawKeys = await localRedis.keys('firm-connections:firm:*');
  const keys = (rawKeys || []).filter((key) => {
    if (limitFirm) return matchFirmId(key) === String(limitFirm).trim();
    return true;
  });

  console.log(`Found ${keys.length} firm-connections keys in local Redis.`);
  if (!keys.length) {
    await localRedis.quit();
    return;
  }

  const batches = [];
  for (let i = 0; i < keys.length; i += 25) {
    batches.push(keys.slice(i, i + 25));
  }

  let pushed = 0;
  for (const batch of batches) {
    const pipe = localRedis.pipeline();
    for (const key of batch) pipe.get(key);
    const rows = await pipe.exec();

    for (let i = 0; i < batch.length; i++) {
      const key = batch[i];
      const row = rows?.[i];
      const raw = row && row[1];
      if (raw == null) continue;

      const write = async (client) => {
        if (dryRun) {
          console.log(`[dry-run] would push ${key}`);
          return;
        }
        await client.set(key, raw);
      };

      await write(upstash);
      if (mirror) await write(mirror);
      pushed += 1;
    }
  }

  console.log(`${dryRun ? 'Previewed' : 'Pushed'} ${pushed} keys to Upstash.`);
  if (dryRun) {
    console.log('No production writes were performed because --dry-run was enabled.');
  }

  await localRedis.quit();
}

main().catch((err) => {
  console.error('Firm connection sync failed:', err?.message || err);
  process.exit(1);
});
