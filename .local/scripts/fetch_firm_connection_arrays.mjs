#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';
import zlib from 'zlib';

const args = process.argv.slice(2);
function getArg(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const firmArg = getArg('firm');
const firmsFile = getArg('firms-file');
const delayMs = Number(getArg('delay-ms', '2500')) || 2500;
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

if (!firmArg && !firmsFile) {
  console.error('Usage: node scripts/fetch_firm_connection_arrays.mjs --firm <CRD> | --firms-file <path> [--delay-ms 2500]');
  process.exit(2);
}

function parseFirmList(filePath) {
  if (!filePath) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((line) => String(line).trim())
    .filter(Boolean)
    .filter((line) => /^[0-9]+$/.test(line));
  return Array.from(new Set(lines));
}

function readFirmIds() {
  if (firmArg) return [String(firmArg).trim()];
  return parseFirmList(firmsFile);
}

function dedupeIds(ids) {
  return Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean)));
}

function decompressPayload(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('br:')) {
    try {
      return zlib.brotliDecompressSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8');
    } catch {
      return raw;
    }
  }
  if (raw.startsWith('gz:')) {
    try {
      return zlib.gunzipSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8');
    } catch {
      return raw;
    }
  }
  return raw;
}

function extractEmploymentRecords(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload?.hits?.hits?.[0]?._source ?? payload;
  const nested = [
    ...(Array.isArray(record?.currentEmployments) ? record.currentEmployments : []),
    ...(Array.isArray(record?.currentIAEmployments) ? record.currentIAEmployments : []),
    ...(Array.isArray(record?.previousEmployments) ? record.previousEmployments : []),
    ...(Array.isArray(record?.previousIAEmployments) ? record.previousIAEmployments : []),
    ...(Array.isArray(record?.finra?.currentEmployments) ? record.finra.currentEmployments : []),
    ...(Array.isArray(record?.finra?.previousEmployments) ? record.finra.previousEmployments : []),
    ...(Array.isArray(record?.sec?.currentIAEmployments) ? record.sec.currentIAEmployments : []),
    ...(Array.isArray(record?.sec?.previousIAEmployments) ? record.sec.previousIAEmployments : []),
  ];
  return nested;
}

function individualReferencesFirm(record, firmId) {
  if (!record) return false;
  const employmentRecords = extractEmploymentRecords(record);
  return employmentRecords.some((entry) => {
    const entryFirmId = entry?.firmId ?? entry?.firm_id ?? entry?.firmID;
    return entryFirmId != null && String(entryFirmId) === String(firmId);
  });
}

async function getLocalIndividualRecord(crd) {
  if (!crd) return null;
  const keys = [`finra:individual:${crd}`, `sec:individual:${crd}`];
  for (const key of keys) {
    try {
      const raw = await redis.get(key);
      if (!raw) continue;
      const text = decompressPayload(raw);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (parsed) return parsed;
    } catch {
      // ignore missing/bad redis keys; the validation is best-effort only
    }
  }
  return null;
}

async function validateConnectionIds(firmId, ids) {
  if (!ids.length) return [];

  const validated = [];
  for (const id of ids) {
    const record = await getLocalIndividualRecord(id);
    if (record && individualReferencesFirm(record, firmId)) {
      validated.push(id);
    }
  }
  return dedupeIds(validated);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchConnectionIds(source, firmId) {
  const url =
    source === 'brokercheck'
      ? `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&hl=true&wt=json&nrows=20`
      : `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&includePrevious&wt=json&nrows=20`;

  const payload = await fetchJson(url);
  if (!payload || !Array.isArray(payload?.hits?.hits)) return [];

  const ids = payload.hits.hits
    .map((hit) => {
      const src = hit?._source || hit || {};
      return (
        String(src.ind_source_id || src.ind_crd || src.individualId || src.id || '').trim()
      );
    })
    .filter(Boolean);

  return dedupeIds(ids);
}

async function saveCurrentIfPresent(source, firmId, ids) {
  if (!ids.length) return false;
  const dir = path.join(process.cwd(), 'data', 'national', source, 'firm', `${firmId}_connection`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'current.json');
  fs.writeFileSync(file, JSON.stringify(ids, null, 2));
  return true;
}

async function main() {
  const firmIds = readFirmIds();
  if (!firmIds.length) {
    console.error('No valid firm CRDs found.');
    process.exit(3);
  }

  for (const firmId of firmIds) {
    for (const source of ['brokercheck', 'adviserinfo']) {
      const ids = await fetchConnectionIds(source, firmId);
      const validatedIds = await validateConnectionIds(firmId, ids);
      const saved = await saveCurrentIfPresent(source, firmId, validatedIds);
      if (saved) {
        console.log(`${source} ${firmId}: validated ${validatedIds.length}/${ids.length} ids`);
      } else {
        console.log(`${source} ${firmId}: no validated data (skipped)`);
      }
      if (firmIds.length > 1 || source === 'brokercheck') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error('firm connection fetch failed:', err);
    process.exit(1);
  } finally {
    await redis.quit().catch(() => {});
  }
})();
