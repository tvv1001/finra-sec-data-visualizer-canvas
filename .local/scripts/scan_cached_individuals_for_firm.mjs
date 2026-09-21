#!/usr/bin/env node
/*
 * scan_cached_individuals_for_firm.mjs
 *
 * Instead of waiting on rate-limited external FINRA/SEC APIs to validate a firm's
 * connections one CRD at a time, this scans EVERY already-cached individual record
 * in local Redis (finra:individual:* and sec:individual:*) and builds the list of
 * individuals whose current/previous employment actually references the target firm.
 * This is a pure local read — no upstream calls, no rate-limit exposure — and can
 * immediately confirm/correct a firm's connections using data we already have.
 *
 * Usage: node scripts/scan_cached_individuals_for_firm.mjs --firm 123635 [--write] [--keep-unconfirmed]
 *
 * Output: prints confirmed current/previous connections found in cache, and
 * (compared against the firm's existing broker-id-mirror lists) which mirror CRDs
 * are NOT confirmed by any cached individual record (still unverified, not necessarily wrong).
 *
 * --write: REPLACES the firm's finra:firm:<id>_brokers:current/previous and
 *   sec:firm:<id>_brokers:current/previous mirror keys with the confirmed-from-cache
 *   results (the authoritative signal: each individual's own current/previous employment
 *   history), then evicts graph:firm-connections:v10:<id> so the app recomputes fresh.
 *   By default this DROPS any previously-mirrored CRD that cache-scanning could not
 *   confirm (since those were unverified/possibly stale). Pass --keep-unconfirmed to
 *   instead union them back in (old-mirror-only CRDs kept, but never override a cache-confirmed
 *   current/previous status).
 */
import Redis from "ioredis";
import zlib from "zlib";

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return def;
}
const FIRM_ID = argVal("firm", null);
if (!FIRM_ID) {
  console.error(
    "Usage: node scripts/scan_cached_individuals_for_firm.mjs --firm <firmId> [--write] [--keep-unconfirmed]",
  );
  process.exit(2);
}
const WRITE = args.includes("--write");
const KEEP_UNCONFIRMED = args.includes("--keep-unconfirmed");

const redis = new Redis("redis://127.0.0.1:6379");

function decompress(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("br:"))
    return zlib
      .brotliDecompressSync(Buffer.from(v.slice(3), "base64"))
      .toString("utf8");
  if (v.startsWith("gz:"))
    return zlib.gunzipSync(Buffer.from(v.slice(3), "base64")).toString("utf8");
  return v;
}

function extractContent(rawJson) {
  // Handles both the raw upstream search-hit shape ({hits:{hits:[{_source:{content}}]}})
  // and a pre-normalized detail object.
  if (rawJson?.hits?.hits?.length) {
    const source = rawJson.hits.hits[0]._source || {};
    const raw = source.content ?? source.iacontent;
    if (raw == null) return null;
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }
  if (
    rawJson?.basicInformation ||
    rawJson?.currentEmployments ||
    rawJson?.currentIAEmployments
  ) {
    return rawJson;
  }
  return null;
}

function employmentArraysReferencingFirm(content, firmId) {
  const currentArrays = [
    content?.currentEmployments,
    content?.currentIAEmployments,
  ].filter(Array.isArray);
  const previousArrays = [
    content?.previousEmployments,
    content?.previousIAEmployments,
  ].filter(Array.isArray);
  const matchesFirm = (e) => {
    const fid = e?.firmId ?? e?.firm_id ?? e?.firmID;
    return fid != null && String(fid) === String(firmId);
  };
  const currentMatch = currentArrays.some((arr) => arr.some(matchesFirm));
  const previousMatch = previousArrays.some((arr) => arr.some(matchesFirm));
  return { currentMatch, previousMatch };
}

function extractName(content) {
  const bi = content?.basicInformation || {};
  return (
    [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(" ") ||
    bi.individualName ||
    ""
  );
}

function isPlainNumericIdArray(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.every((item) => {
        if (typeof item === "number") return Number.isFinite(item);
        if (typeof item === "string") return /^\d{1,10}$/.test(item.trim());
        return false;
      })
    );
  } catch {
    return false;
  }
}

function compress(str) {
  if (isPlainNumericIdArray(str)) return str;
  return (
    "br:" + zlib.brotliCompressSync(Buffer.from(str, "utf8")).toString("base64")
  );
}

async function getFirmMirrorCrds(firmId) {
  const all = new Set();
  for (const prefix of ["finra", "sec"]) {
    for (const suffix of ["current", "previous"]) {
      const key = `${prefix}:firm:${firmId}_brokers:${suffix}`;
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const arr = JSON.parse(decompress(raw));
        if (Array.isArray(arr)) arr.forEach((c) => all.add(String(c)));
      } catch {}
    }
  }
  return all;
}

async function main() {
  console.log(`Scanning all cached individual records for firm ${FIRM_ID}...`);
  const finraKeys = await redis.keys("finra:individual:*");
  const secKeys = await redis.keys("sec:individual:*");
  const allKeys = [...new Set([...finraKeys, ...secKeys])];
  console.log(`Total cached individual keys to scan: ${allKeys.length}`);

  const confirmedCurrent = [];
  const confirmedPrevious = [];
  let scanned = 0;
  let parseErrors = 0;

  const BATCH_SIZE = 500;
  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    const pipeline = redis.pipeline();
    batch.forEach((key) => pipeline.get(key));
    const results = await pipeline.exec();
    for (let j = 0; j < batch.length; j++) {
      scanned++;
      const key = batch[j];
      const crd = key.split(":").pop();
      const [err, raw] = results[j] || [];
      if (err || !raw) continue;
      try {
        const json = JSON.parse(decompress(raw));
        const content = extractContent(json);
        if (!content) continue;
        const { currentMatch, previousMatch } = employmentArraysReferencingFirm(
          content,
          FIRM_ID,
        );
        const source = key.startsWith("sec:") ? "sec" : "finra";
        if (currentMatch)
          confirmedCurrent.push({ crd, name: extractName(content), source });
        else if (previousMatch)
          confirmedPrevious.push({ crd, name: extractName(content), source });
      } catch {
        parseErrors++;
      }
    }
    if (scanned % 5000 < BATCH_SIZE)
      console.log(`  scanned ${scanned}/${allKeys.length}...`);
  }

  console.log(`\n=== Results for firm ${FIRM_ID} ===`);
  console.log(
    `Confirmed CURRENT connections (from cached individual records): ${confirmedCurrent.length}`,
  );
  confirmedCurrent.forEach((c) =>
    console.log(`  - ${c.crd}: ${c.name || "(no name)"}`),
  );
  console.log(
    `\nConfirmed PREVIOUS connections (from cached individual records): ${confirmedPrevious.length}`,
  );
  confirmedPrevious.forEach((c) =>
    console.log(`  - ${c.crd}: ${c.name || "(no name)"}`),
  );
  console.log(`\n(parse errors while scanning: ${parseErrors})`);

  // Cross-check against the firm's existing broker-id-mirror lists.
  const mirrorCrds = await getFirmMirrorCrds(FIRM_ID);
  const confirmedCrds = new Set(
    [...confirmedCurrent, ...confirmedPrevious].map((c) => c.crd),
  );
  const mirrorOnly = [...mirrorCrds].filter((c) => !confirmedCrds.has(c));
  const confirmedNotInMirror = [...confirmedCrds].filter(
    (c) => !mirrorCrds.has(c),
  );
  console.log(
    `\nFirm's broker-id-mirror total unique CRDs: ${mirrorCrds.size}`,
  );
  console.log(
    `Mirror CRDs still unconfirmed (no cached individual record proves/disproves them yet): ${mirrorOnly.length}`,
  );
  if (confirmedNotInMirror.length) {
    console.log(
      `CRDs confirmed via cache but MISSING from the firm's mirror lists (should be added): ${confirmedNotInMirror.length}`,
    );
    confirmedNotInMirror.forEach((c) => console.log(`  - ${c}`));
  }

  if (WRITE) {
    // Split confirmed CRDs by their source (finra vs sec cache) so both mirror namespaces
    // stay populated correctly. A CRD confirmed via a finra:individual: record goes into
    // finra:firm:<id>_brokers:*, one confirmed via sec:individual: goes into sec:firm:<id>_brokers:*.
    const currentBySource = { finra: new Set(), sec: new Set() };
    const previousBySource = { finra: new Set(), sec: new Set() };
    confirmedCurrent.forEach((c) => currentBySource[c.source].add(c.crd));
    confirmedPrevious.forEach((c) => previousBySource[c.source].add(c.crd));

    if (KEEP_UNCONFIRMED) {
      // Union in old mirror-only CRDs (unconfirmed either way) without overriding any
      // cache-confirmed current/previous status already computed above.
      for (const prefix of ["finra", "sec"]) {
        for (const suffix of ["current", "previous"]) {
          const key = `${prefix}:firm:${FIRM_ID}_brokers:${suffix}`;
          try {
            const raw = await redis.get(key);
            if (!raw) continue;
            const arr = JSON.parse(decompress(raw));
            if (!Array.isArray(arr)) continue;
            const target =
              suffix === "current"
                ? currentBySource[prefix]
                : previousBySource[prefix];
            const otherTarget =
              suffix === "current"
                ? previousBySource[prefix]
                : currentBySource[prefix];
            arr.forEach((c) => {
              const crd = String(c);
              if (!otherTarget.has(crd)) target.add(crd);
            });
          } catch {}
        }
      }
    }

    console.log(
      `\n--write: skipped finra/sec:firm:*_brokers:* writes. Use Redis firm-connections:firm:${FIRM_ID} as the roster.`,
    );
  }

  await redis.quit();
}

main().catch((err) => {
  console.error("scan_cached_individuals_for_firm crashed:", err);
  process.exit(2);
});
