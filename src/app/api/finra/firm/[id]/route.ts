import { NextRequest, NextResponse } from "next/server";
import { canCallExternalApis } from "@/lib/externalApiGate";
import { cachedFetch, evictCacheKey } from "@/lib/simpleCache";
import { rememberRecentSeed } from "@/lib/seedStore";
import { sharedCacheHeaders } from "@/lib/httpCache";
import { logger } from "@/lib/logger";
import { queueHydration } from "@/lib/hydration";
import { getRedisClientInstance } from "@/lib/redisClient";
import { compressPayload, setStringIfValid } from "@/lib/redisCache";
import { addRecordToSearchIndex } from "@/lib/localSearch";
import {
  recordOwnerReferencesForFirm,
  lookupFirmReference,
} from "@/lib/ownerReferenceIndex";
import { hasFirmSourceCoverage } from "@/lib/sourceTruth";
import { rememberInventoryEntities } from "@/lib/crdInventorySidecar";

// Allow ISR for firm API responses to reduce SSR load and repeated upstream
// external fetches. Cache for 1 hour by default; individual callers can use
// `forceRefresh=1` to evict and refresh.
export const dynamic = "auto";
export const revalidate = 1209600;

const SUPPRESSED_SEC_FIRM_IDS = new Set(["4039", "25156", "36773"]);

function buildFirmQueryParams(searchParams: URLSearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (!value) continue;
    params.set(key, value);
  }
  if (!params.has("hl")) params.set("hl", "true");
  if (!params.has("wt")) params.set("wt", "json");
  params.delete("nrows");
  return params;
}

function parseDetailPayload(data: any, contentKey = "content") {
  if (!data) return null;

  const extractFromSource = (src: any) => {
    if (!src) return null;
    const raw = src[contentKey];
    if (!raw) return null;

    let parsed: any = null;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    } else if (raw && typeof raw === "object") {
      parsed = raw;
    }

    if (!parsed) return null;

    if (!parsed.basicInformation) {
      const bi: any = {};
      const fid = parsed.firmId || parsed.firm_id || parsed.id;
      if (fid) bi.firmId = fid;
      if (parsed.firmName || parsed.firm_name || parsed.name)
        bi.firmName = parsed.firmName || parsed.firm_name || parsed.name;
      if (parsed.bcScope || parsed.bc_scope)
        bi.bcScope = parsed.bcScope || parsed.bc_scope;
      if (parsed.iaScope || parsed.ia_scope)
        bi.iaScope = parsed.iaScope || parsed.ia_scope;
      if (parsed.bdSECNumber || parsed.bd_sec_number)
        bi.bdSECNumber = parsed.bdSECNumber || parsed.bd_sec_number;
      if (parsed.iaSECNumber || parsed.ia_sec_number)
        bi.iaSECNumber = parsed.iaSECNumber || parsed.ia_sec_number;
      if (Object.keys(bi).length) parsed.basicInformation = bi;
    }

    const looksLikeDetail =
      parsed.basicInformation ||
      parsed.firmId ||
      parsed.bdSECNumber ||
      parsed.firmName ||
      parsed.firmStatus ||
      parsed.disclosures ||
      parsed.directOwners;
    return looksLikeDetail ? parsed : null;
  };

  if (data?.hits?.hits?.length) {
    return extractFromSource(data.hits.hits[0]?._source);
  }

  return extractFromSource(data);
}

function buildSecDocumentLinks(opts: {
  summaryId: string;
  reportId?: string | null;
  isIaFirm?: boolean;
  crsFileId?: string | null;
}) {
  const summaryId = String(opts.summaryId || "").trim();
  if (!summaryId) return [];
  const reportId = String(opts.reportId || summaryId).trim();
  
  const links = [
    {
      label: "SEC AdvisorInfo Summary",
      href: `https://adviserinfo.sec.gov/firm/summary/${summaryId}`,
    }
  ];

  if (opts.isIaFirm) {
    links.push({
      label: "Latest Form ADV filed",
      href: `https://reports.adviserinfo.sec.gov/reports/ADV/${reportId}/PDF/${reportId}.pdf`,
    });
    links.push({
      label: "SEC firm brochure",
      href: `https://adviserinfo.sec.gov/firm/brochure/${summaryId}`,
    });
  }

  if (opts.crsFileId) {
    links.push({
      label: "SEC Form CRS",
      href: `https://files.brokercheck.finra.org/crs_${opts.crsFileId}`,
    });
  } else if (opts.isIaFirm) {
    links.push({
      label: "SEC Form CRS",
      href: `https://reports.adviserinfo.sec.gov/crs/crs_${reportId}.pdf`,
    });
  }

  return links;
}

function buildFinraDocumentLinks(id: string) {
  if (!id) return [];
  return [
    {
      label: "FINRA BrokerCheck Summary",
      href: `https://brokercheck.finra.org/firm/summary/${id}`,
    },
    {
      label: "FINRA Firm Detail (BrokerCheck)",
      href: `https://brokercheck.finra.org/firm/summary/${id}`,
    },
  ];
}

function normalizeSecFirmId(value: string | number | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^8-\d+$/i.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `8-${raw}`;
  return raw;
}

function hasAnyItems(list: unknown) {
  return Array.isArray(list) && list.length > 0;
}

function hasPublicFinraFirmDetail(
  detail: any,
  basicInformation: Record<string, any> = {},
) {
  if (!detail || typeof detail !== "object") return false;

  const bcScope = String(detail?.bcScope || basicInformation?.bcScope || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (bcScope === "notinscope") return false;
  if (bcScope) return true;

  if (
    String(detail?.isLegacy || basicInformation?.isLegacy || "")
      .trim()
      .toUpperCase() === "Y"
  )
    return true;
  if (hasAnyItems(detail?.selfRegulatoryOrgs)) return true;
  if (
    Boolean(
      String(
        detail?.districtName || basicInformation?.districtName || "",
      ).trim(),
    )
  )
    return true;
  if (
    Boolean(
      String(
        detail?.bdSECNumber ||
          detail?.bdSecNumber ||
          basicInformation?.bdSECNumber ||
          basicInformation?.bdSecNumber ||
          "",
      ).trim(),
    )
  )
    return true;

  return false;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) {
    return NextResponse.json({ error: "Invalid firm ID." }, { status: 400 });
  }
  const isMergedRoute = request.nextUrl.searchParams.get("merged") === "1";
  const forceRefresh = request.nextUrl.searchParams.get("forceRefresh") === "1";
  const writeRequested =
    request.nextUrl.searchParams.get("write") === "1" ||
    request.nextUrl.searchParams.get("refreshWrite") === "1";

  const useRedisOnly =
    String(process.env.USE_REDIS_ONLY || "").toLowerCase() === "1";

  // If a merged disk fallback file exists and the caller requested the merged view,
  // prefer returning the precomputed merged payload immediately. This avoids
  // unnecessary external fetches and prevents the server from logging a disk
  // fallback during normal dev work where merged files are intentionally created.
  if (isMergedRoute) {
    if (useRedisOnly) {
      logger.info("skipping-merged-disk-file-due-to-USE_REDIS_ONLY", { id });
    } else {
      try {
        const fs = require("fs");
        const path = require("path");
        const mergedFile = path.join(
          process.cwd(),
          "data",
          "national",
          `finra-firm-${id}.json`,
        );
        if (fs.existsSync(mergedFile)) {
          const raw = fs.readFileSync(mergedFile, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed && parsed.merged) {
            logger.info("serving-merged-disk-file", { id, file: mergedFile });
            return NextResponse.json(
              {
                firmId: id,
                found: parsed.found !== false,
                hasFinraData:
                  Boolean(parsed.merged?.hasFinraData) ||
                  Boolean(parsed.sources?.finra),
                hasSecData:
                  Boolean(parsed.merged?.hasSecData) ||
                  Boolean(parsed.sources?.sec),
                finraNode: parsed.merged,
                sources: parsed.sources || {
                  finra: parsed.sources?.finra,
                  sec: parsed.sources?.sec,
                },
                merged: parsed.merged,
              },
              { headers: sharedCacheHeaders(1209600) },
            );
          }
        }
      } catch (e) {
        // ignore and continue to normal fetch path
      }
    }
  }

  if (forceRefresh) {
    // Evict firm detail caches only. Do not delete Redis `firm-connections:firm:{id}` —
    // that roster is the curated people list and is already populated independently.
    await Promise.allSettled([
      evictCacheKey(`finra:firm:${id}`),
      evictCacheKey(`sec:firm:${id}`),
      evictCacheKey(`sec:firm:summaryHtml:${id}`),
    ]);

    if (writeRequested) {
      // also clear the finra/sec keys so subsequent external fetches are fresh
      try {
        const redis = getRedisClientInstance({
          url: process.env.UPSTASH_REDIS_REST_URL || "",
          token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
        });
        if (redis) {
          await Promise.allSettled([
            redis.del(`finra:firm:${id}`),
            redis.del(`sec:firm:${id}`),
            redis.del(`finra:firm:summaryHtml:${id}`),
            redis.del(`sec:firm:summaryHtml:${id}`),
          ]);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  void rememberRecentSeed("firm", id).catch((error) => {
    logger.warn("failed to remember recent firm seed", {
      id,
      error: error?.message || String(error),
    });
  });

  try {
    const params = buildFirmQueryParams(new URL(request.url).searchParams);
    const queryString = params.toString();

    const fetchOptions = {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://brokercheck.finra.org/",
      },
      next: { revalidate: 1209600 },
    };

    const [bcData, secData, secPageData] = await Promise.allSettled([
      cachedFetch(`finra:firm:${id}`, 60 * 60 * 24, async () => {
        try {
          const url = `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&wt=json`;
          const res = await fetch(url, fetchOptions);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        } catch (err: any) {
          logger.warn("FINRA firm external fetch failed", {
            id,
            error: err.message,
          });
          return undefined;
        }
      }),
      cachedFetch(`sec:firm:${id}`, 60 * 60 * 24, async () => {
        try {
          const url = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;
          const res = await fetch(url, {
            ...fetchOptions,
            headers: {
              ...fetchOptions.headers,
              Referer: "https://adviserinfo.sec.gov/",
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        } catch (err: any) {
          logger.warn("SEC firm external fetch failed", {
            id,
            error: err.message,
          });
          return undefined;
        }
      }),
      cachedFetch(`sec:firm:summaryHtml:${id}`, 60 * 60 * 24, async () => {
        try {
          const url = `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(id)}`;
          const res = await fetch(url, {
            ...fetchOptions,
            headers: {
              ...fetchOptions.headers,
              Referer: "https://adviserinfo.sec.gov/",
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        } catch (err: any) {
          logger.warn("SEC firm summaryHtml fetch failed", {
            id,
            error: err.message,
          });
          return undefined;
        }
      }),
    ]);

    // Also fetch the FINRA BrokerCheck summary HTML so we can detect a real upstream
    // detail page (and reserve the orphan template only for records that actually
    // have an API detail page present).
    const finraPageData = await cachedFetch(
      `finra:firm:summaryHtml:${id}`,
      60 * 60 * 24,
      async () => {
        try {
          const url = `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(id)}`;
          const res = await fetch(url, {
            ...fetchOptions,
            headers: {
              ...fetchOptions.headers,
              Referer: "https://brokercheck.finra.org/",
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        } catch (err: any) {
          logger.warn("FINRA firm summaryHtml fetch failed", {
            id,
            error: err.message,
          });
          return undefined;
        }
      },
    );

    console.log(
      "bcData status",
      bcData.status,
      (bcData as any).value ? "has value" : "no value",
    );
    let bcDetail: any = null;
    if (bcData.status === "fulfilled") {
      bcDetail = parseDetailPayload(bcData.value, "content");
    }

    // If we found a Redis-backed payload but parsing produced no usable detail,
    // treat that as "poor data" and attempt a one-off refresh from the external
    // API (without persisting) so the UI shows a fixed view while you navigate.
    if (!bcDetail && bcData.status === "fulfilled" && bcData.value) {
      try {
        logger.info("poor-data-detected-in-redis-key", {
          id,
          key: `finra:firm:${id}`,
        });
        // Remove the bad key so cachedFetch/external fetchers will be able to
        // provide a fresh value.
        await evictCacheKey(`finra:firm:${id}`);
        // Try an immediate external fetch to replace the bad value in-memory for
        // this request. Do not persist unless writeRequested is true (handled
        // later).
        if (canCallExternalApis()) {
          const url = `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&wt=json`;
          const res = await fetch(url, {
            headers: fetchOptions.headers,
            next: fetchOptions.next,
          });
          if (res.ok) {
            const fresh = await res.json();
            bcData.value = fresh;
            bcDetail = parseDetailPayload(fresh, "content");
            logger.info("refreshed-poor-redis-key-from-external", {
              id,
              key: `finra:firm:${id}`,
            });
            try {
              const redis = getRedisClientInstance({
                url: process.env.UPSTASH_REDIS_REST_URL || "",
                token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
              });
              if (redis) {
                await redis.lpush(
                  "dashboard:alerts",
                  JSON.stringify({
                    at: new Date().toISOString(),
                    id,
                    entity: "firm",
                    type: "auto-heal",
                    source: "finra",
                  }),
                );
                await redis.ltrim("dashboard:alerts", 0, 999).catch(() => null);
              }
            } catch (e) {}
            // Auto-persist when UPSTASH_ALLOW_WRITES=1 or when caller explicitly requested write
            if (
              String(process.env.UPSTASH_ALLOW_WRITES || "").toLowerCase() ===
                "1" ||
              writeRequested
            ) {
              try {
                await setStringIfValid(
                  `finra:firm:${id}`,
                  JSON.stringify(fresh),
                  null,
                );
                logger.info("auto-healed-and-wrote-redis-key", {
                  id,
                  key: `finra:firm:${id}`,
                });
              } catch (e) {
                // ignore write errors
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // Additional fallback: some cached payloads use a different envelope (finraBrokerCheck)
    if (
      !bcDetail &&
      bcData.status === "fulfilled" &&
      bcData.value &&
      typeof bcData.value === "object"
    ) {
      if (
        bcData.value.finraBrokerCheck &&
        typeof bcData.value.finraBrokerCheck === "object"
      ) {
        bcDetail = bcData.value.finraBrokerCheck;
        logger.info("firm-detail-envelope-fallback", {
          id,
          source: "finra",
          note: "used finraBrokerCheck envelope",
        });
      }
    }

    // Fallback: if parse failed (possibly due to primed-bundle collision), try reading
    // the local disk cache file directly as a last resort so local dev shows details.
    if (!bcDetail) {
      if (useRedisOnly) {
        logger.info("skipping-bc-disk-fallback-due-to-USE_REDIS_ONLY", { id });
      } else {
        try {
          const fs = require("fs");
          const path = require("path");
          const filePath = path.join(
            process.cwd(),
            "data",
            "national",
            "brokercheck.finra.org",
            `api.brokercheck.finra.org_search_firm_${id}.json`,
          );
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            const alt = parseDetailPayload(parsed, "content");
            if (alt) {
              bcDetail = alt;
              logger.info("firm-detail-disk-fallback", {
                id,
                source: "finra",
                note: "used disk cache fallback for finra firm detail",
              });
              try {
                const redis = getRedisClientInstance({
                  url: process.env.UPSTASH_REDIS_REST_URL || "",
                  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
                });
                await redis.lpush(
                  "dashboard:alerts",
                  JSON.stringify({
                    at: new Date().toISOString(),
                    id,
                    source: "finra",
                    type: "disk-fallback",
                    note: "used disk cache fallback for finra firm detail",
                  }),
                );
                await redis.ltrim("dashboard:alerts", 0, 499).catch(() => null);
              } catch (e) {
                // ignore alerting errors
              }
            }
          }
        } catch (e) {
          // ignore fallback errors
        }
      }
    }

    let secDetail: any = null;
    if (secData.status === "fulfilled") {
      secDetail = parseDetailPayload(secData.value, "iacontent");
    }

    // Same poor-data detection & refresh for SEC payloads
    if (!secDetail && secData.status === "fulfilled" && secData.value) {
      try {
        logger.info("poor-data-detected-in-redis-key", {
          id,
          key: `sec:firm:${id}`,
        });
        await evictCacheKey(`sec:firm:${id}`);
        if (canCallExternalApis()) {
          const url = `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;
          const res = await fetch(url, {
            headers: {
              ...fetchOptions.headers,
              Referer: "https://adviserinfo.sec.gov/",
            },
            next: fetchOptions.next,
          });
          if (res.ok) {
            const fresh = await res.json();
            secData.value = fresh;
            secDetail = parseDetailPayload(fresh, "iacontent");
            logger.info("refreshed-poor-redis-key-from-external", {
              id,
              key: `sec:firm:${id}`,
            });
            try {
              const redis2 = getRedisClientInstance({
                url: process.env.UPSTASH_REDIS_REST_URL || "",
                token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
              });
              if (redis2) {
                await redis2.lpush(
                  "dashboard:alerts",
                  JSON.stringify({
                    at: new Date().toISOString(),
                    id,
                    entity: "firm",
                    type: "auto-heal",
                    source: "sec",
                  }),
                );
                await redis2
                  .ltrim("dashboard:alerts", 0, 999)
                  .catch(() => null);
              }
            } catch (e) {}
            // Auto-persist when UPSTASH_ALLOW_WRITES=1 or when caller explicitly requested write
            if (
              String(process.env.UPSTASH_ALLOW_WRITES || "").toLowerCase() ===
                "1" ||
              writeRequested
            ) {
              try {
                await setStringIfValid(
                  `sec:firm:${id}`,
                  JSON.stringify(fresh),
                  null,
                );
                logger.info("auto-healed-and-wrote-redis-key", {
                  id,
                  key: `sec:firm:${id}`,
                });
              } catch (e) {
                // ignore write errors
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // Additional fallback: sec envelope variations
    if (
      !secDetail &&
      secData.status === "fulfilled" &&
      secData.value &&
      typeof secData.value === "object"
    ) {
      if (
        secData.value.iacontent &&
        typeof secData.value.iacontent === "object"
      ) {
        secDetail = secData.value.iacontent;
        logger.info("firm-detail-envelope-fallback", {
          id,
          source: "sec",
          note: "used iacontent envelope",
        });
      } else if (
        secData.value.iaContent &&
        typeof secData.value.iaContent === "object"
      ) {
        secDetail = secData.value.iaContent;
        logger.info("firm-detail-envelope-fallback", {
          id,
          source: "sec",
          note: "used iaContent envelope",
        });
      }
    }

    // Disk fallback for SEC detail when cached/primed fetch returns non-detail.
    if (!secDetail) {
      if (useRedisOnly) {
        logger.info("skipping-sec-disk-fallback-due-to-USE_REDIS_ONLY", { id });
      } else {
        try {
          const fs = require("fs");
          const path = require("path");
          const filePath = path.join(
            process.cwd(),
            "data",
            "national",
            "adviserinfo.sec.gov",
            `api.adviserinfo.sec.gov_search_firm_${id}.json`,
          );
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            const alt = parseDetailPayload(parsed, "iacontent");
            if (alt) {
              secDetail = alt;
              logger.info("firm-detail-disk-fallback", {
                id,
                source: "sec",
                note: "used disk cache fallback for sec firm detail",
              });
              try {
                const redis2 = getRedisClientInstance({
                  url: process.env.UPSTASH_REDIS_REST_URL || "",
                  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
                });
                await redis2.lpush(
                  "dashboard:alerts",
                  JSON.stringify({
                    at: new Date().toISOString(),
                    id,
                    source: "sec",
                    type: "disk-fallback",
                    note: "used disk cache fallback for sec firm detail",
                  }),
                );
                await redis2
                  .ltrim("dashboard:alerts", 0, 499)
                  .catch(() => null);
              } catch (e) {
                // ignore alerting errors
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    // Determine whether the upstream SEC/FINRA summary pages exist and look valid.
    const secHtml =
      secPageData?.status === "fulfilled" ? secPageData.value : null;
    let secPageValid = false;
    try {
      if (typeof secHtml === "string" && secHtml.trim().length > 200) {
        const low = secHtml.toLowerCase();
        if (
          low.includes("firm summary") ||
          low.includes("adviserinfo") ||
          (String(id) &&
            low.includes(`/firm/summary/${String(id).toLowerCase()}`))
        ) {
          secPageValid = true;
        }
        if (!secPageValid && secHtml.length > 5000) secPageValid = true;
      }
    } catch (e) {
      secPageValid = false;
    }

    // finraPageData is the actual fetched text (or undefined) from cachedFetch above.
    const finraHtml = typeof finraPageData === "string" ? finraPageData : null;
    let finraPageValid = false;
    try {
      if (typeof finraHtml === "string" && finraHtml.trim().length > 200) {
        const low = finraHtml.toLowerCase();
        if (
          low.includes("brokercheck") ||
          low.includes("firm summary") ||
          (String(id) &&
            low.includes(`/firm/summary/${String(id).toLowerCase()}`))
        ) {
          finraPageValid = true;
        }
        if (!finraPageValid && finraHtml.length > 5000) finraPageValid = true;
      }
    } catch (e) {
      finraPageValid = false;
    }

    if (!bcDetail && !secDetail) {
      // If FINRA/SEC search returns a hit, but it lacks a full detail profile (no `content` / `iacontent`),
      // construct an orphan from the search hit rather than falling back immediately.
      const bcSearchHit =
        bcData.status === "fulfilled" && bcData.value?.hits?.hits?.length
          ? bcData.value.hits.hits[0]._source
          : null;
      const secSearchHit =
        secData.status === "fulfilled" && secData.value?.hits?.hits?.length
          ? secData.value.hits.hits[0]._source
          : null;
      const searchHit = bcSearchHit || secSearchHit;

      const firmReference = await lookupFirmReference(id).catch(() => null);
      let orphan = null;
      // Strict orphan rule: only return an orphan when an upstream detail page exists
      // (FINRA or SEC summary) or the record is already known as a legacy scraped-only
      // firm reference from a person's employment history.
      const externalDetailPageExists = Boolean(secPageValid || finraPageValid);
      if (searchHit && externalDetailPageExists) {
        orphan = {
          firmId: id,
          firmName:
            searchHit.firm_name ||
            searchHit.firmName ||
            searchHit.name ||
            `Firm ${id}`,
          bcScope: searchHit.firm_bc_scope || searchHit.bcScope || "NotInScope",
          iaScope: searchHit.iaScope || "NotInScope",
          firmStatus:
            searchHit.firmStatus ||
            searchHit.status ||
            searchHit.registrationStatus ||
            "Terminated",
          bdSECNumber: searchHit.firm_bd_sec_number || searchHit.bdSecNumber,
          iaSECNumber: searchHit.firm_ia_sec_number || searchHit.iaSecNumber,
          _externalPages: { finra: finraPageValid, sec: secPageValid },
        };
      } else if (firmReference) {
        orphan = {
          firmId: id,
          firmName: firmReference.firmName || `Firm ${id}`,
          name: firmReference.name,
          parentCrd: firmReference.parentCrd || id,
          parentType: firmReference.parentType || "individual",
          bcScope: "NotInScope",
          iaScope: "NotInScope",
          firmStatus: "Legacy / non-live",
          officeAddress: firmReference.officeAddress,
          mailingAddress: firmReference.mailingAddress,
          phone: firmReference.phone,
          _externalPages: { finra: finraPageValid, sec: secPageValid },
        };
      }

      if (orphan) {
        return NextResponse.json(
          {
            found: true,
            firmId: id,
            orphan,
            debugBcData: (bcData as any).value,
            sources: { finra: { found: false }, sec: { found: false } },
            hasFinraData: false,
            hasSecData: false,
          },
          { headers: sharedCacheHeaders(1209600) },
        );
      }
      return NextResponse.json(
        { found: false },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          },
        },
      );
    }

    let detail: any = bcDetail || secDetail;
    if (secDetail) {
      const sbi = secDetail.basicInformation || {};
      const dbi = detail.basicInformation || {};
      const mergeField = (key: string) => {
        if (!dbi[key] && sbi[key]) dbi[key] = sbi[key];
      };
      [
        "firmStatus",
        "firmStatusDate",
        "firmType",
        "firmSize",
        "regulator",
        "formedState",
        "formedDate",
        "districtName",
        "isLegacy",
        "iaSECNumber",
        "bdSECNumber",
        "bcScope",
        "iaScope",
        "fiscalMonthEndCode",
      ].forEach(mergeField);
      if ((!dbi.otherNames || !dbi.otherNames.length) && sbi.otherNames?.length)
        dbi.otherNames = sbi.otherNames;
      detail.basicInformation = dbi;

      if (!detail.firmAddressDetails && secDetail.firmAddressDetails)
        detail.firmAddressDetails = secDetail.firmAddressDetails;
      if (!detail.iaFirmAddressDetails && secDetail.iaFirmAddressDetails)
        detail.iaFirmAddressDetails = secDetail.iaFirmAddressDetails;
      if (!detail.registrations && secDetail.registrations)
        detail.registrations = secDetail.registrations;
      if (!detail.registrationStatus && secDetail.registrationStatus)
        detail.registrationStatus = secDetail.registrationStatus;
      if (!detail.noticeFilings && secDetail.noticeFilings)
        detail.noticeFilings = secDetail.noticeFilings;
      if (!detail.directOwners?.length && secDetail.directOwners?.length)
        detail.directOwners = secDetail.directOwners;
      if (!detail.disclosures?.length && secDetail.disclosures?.length)
        detail.disclosures = secDetail.disclosures;
      if (!detail.brochures && secDetail.brochures)
        detail.brochures = secDetail.brochures;
    }

    const secNumberRaw =
      detail?.basicInformation?.iaSECNumber ||
      detail?.basicInformation?.iaSecNumber ||
      detail?.basicInformation?.bdSECNumber ||
      detail?.basicInformation?.bdSecNumber ||
      detail?.iaSECNumber ||
      detail?.iaSecNumber ||
      detail?.bdSECNumber ||
      detail?.bdSecNumber ||
      "";
    const secFirmId = normalizeSecFirmId(secNumberRaw || id);
    // AdvisorInfo firm/summary and brochure routes resolve by CRD when no real SEC# exists.
    const secSummaryId = String(id).trim();
    detail.hasFinraData = hasPublicFinraFirmDetail(
      bcDetail,
      bcDetail?.basicInformation || {},
    );

    const suppressSecLinks = SUPPRESSED_SEC_FIRM_IDS.has(id);
    // FINRA's own BrokerCheck payload frequently embeds SEC/IA fields (iaScope, iaSECNumber, etc.)
    // even when the separate SEC AdviserInfo fetch is unavailable (e.g. rate-limited or gated off
    // locally). Treat that embedded coverage as equivalent to a direct SEC detail hit so the SEC
    // tag/link isn't suppressed just because the secondary SEC fetch didn't run.
    const secHasCoverage =
      (secDetail && hasFirmSourceCoverage(secDetail, "sec")) ||
      hasFirmSourceCoverage(detail, "sec") ||
      hasFirmSourceCoverage(bcDetail, "sec");
    detail.hasSecData =
      !suppressSecLinks &&
      Boolean(secSummaryId) &&
      Boolean(secHasCoverage || detail?.hasSecData);

    if (detail.hasFinraData || detail.hasSecData) {
      void rememberInventoryEntities([{ kind: "firm", id }]).catch((err: any) => {
        logger.warn("failed to update inventory sidecar for firm", {
          id,
          error: err?.message || String(err),
        });
      });
    }

    if (
      !suppressSecLinks &&
      typeof detail.secSummaryDescription === "string" &&
      !detail.secSummaryDescription.trim()
    ) {
      delete detail.secSummaryDescription;
    }

    if (
      !suppressSecLinks &&
      Boolean(secSummaryId) &&
      (!Array.isArray(detail.secDocumentLinks) ||
        !detail.secDocumentLinks.length)
    ) {
      // Only attach SEC document links if the SEC summary page appears valid, or we otherwise
      // have confirmed SEC/IA coverage for this firm (e.g. embedded in the FINRA payload even
      // when the separate SEC summary-page fetch was gated off/unavailable locally).
      if (secPageValid || secHasCoverage) {
        detail.secDocumentLinks = buildSecDocumentLinks({
          summaryId: secSummaryId,
          reportId: secFirmId || secSummaryId,
          isIaFirm: detail.iaDisclosureFlag === 'Y' || !!(detail.basicInformation?.iaSECNumber || detail.basicInformation?.iaSecNumber),
          crsFileId: detail.basicInformation?.crs?.fileId || null
        });
      } else {
        detail.secDocumentLinks = [];
      }
    }

    if (!detail.hasSecData) {
      detail.secSummaryDescription = undefined;
      detail.secDocumentLinks = [];
    }

    // Attach FINRA BrokerCheck links when FINRA content exists so UI can render a FINRA button.
    try {
      if (
        bcDetail &&
        (!Array.isArray(detail.finraDocumentLinks) ||
          !detail.finraDocumentLinks.length)
      ) {
        detail.finraDocumentLinks = buildFinraDocumentLinks(id);
      }
    } catch (e) {
      // noop
    }

    // Queue background hydration of the external API to ensure cache stays hydrated
    queueHydration("firm", id);

    // Best-effort: index this firm's directOwners/indirectOwners so a later lookup of one of
    // those individuals (many of whom have no independent, searchable FINRA/SEC record) can
    // resolve as an "orphan" reference instead of a bare not-found. Never blocks the response.
    const ownerReferenceRows = [
      ...(Array.isArray(detail.directOwners) ? detail.directOwners : []),
      ...(Array.isArray(detail.indirectOwners) ? detail.indirectOwners : []),
    ];
    if (ownerReferenceRows.length) {
      void recordOwnerReferencesForFirm({
        parentCrd: id,
        firmName: detail.basicInformation?.firmName || detail.firmName,
        officeAddress: detail.firmAddressDetails?.officeAddress,
        mailingAddress: detail.firmAddressDetails?.mailingAddress,
        phone: detail.firmAddressDetails?.businessPhoneNumber,
        firmStatus: detail.basicInformation?.bcScope || detail.basicInformation?.firmStatus || detail.bcScope || undefined,
        owners: ownerReferenceRows,
      }).catch((err: any) => {
        logger.warn("failed to record owner reference index for firm", {
          id,
          error: err?.message || String(err),
        });
      });
    }

    const searchIndexDetail =
      detail && typeof detail === "object" ? detail : null;
    try {
      await addRecordToSearchIndex("finra", "firm", id, searchIndexDetail);
    } catch (searchIndexErr: any) {
      logger.warn(
        "failed to update local firm search index from detail route",
        { id, error: searchIndexErr?.message || String(searchIndexErr) },
      );
    }

    // If the caller explicitly requested writes, persist the fresh external
    // responses into Redis regardless of UPSTASH_ALLOW_WRITES so you can
    // validate FINRA+SEC payloads on-demand. This is a one-off action gated by
    // the `write=1` or `refreshWrite=1` query parameter.
    if (writeRequested) {
      try {
        const redis = getRedisClientInstance({
          url: process.env.UPSTASH_REDIS_REST_URL || "",
          token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
        });
        if (redis) {
          // FINRA JSON
          if (bcData?.status === "fulfilled" && bcData?.value) {
            const raw = JSON.stringify(bcData.value);
            await redis
              .set(`finra:firm:${id}`, compressPayload(raw))
              .catch(() => null);
          }
          // SEC JSON
          if (secData?.status === "fulfilled" && secData?.value) {
            const raw = JSON.stringify(secData.value);
            await redis
              .set(`sec:firm:${id}`, compressPayload(raw))
              .catch(() => null);
          }
          // Summary HTML (plain string)
          if (typeof finraPageData === "string")
            await redis
              .set(`finra:firm:summaryHtml:${id}`, finraPageData)
              .catch(() => null);
          if (typeof secPageData === "string")
            await redis
              .set(`sec:firm:summaryHtml:${id}`, secPageData)
              .catch(() => null);
        }
      } catch (e) {
        logger.warn("failed to write refresh keys to redis", {
          id,
          error: e?.message || String(e),
        });
      }
    }

    if (isMergedRoute) {
      // People lists live on Redis `firm-connections:firm:{id}` and are loaded from
      // /api/finra/firm/{id}/connections. Never inline them here — mega-firms (7691)
      // became a 12MB JSON body and froze production.
      return NextResponse.json(
        {
          firmId: id,
          found: true,
          hasFinraData: detail.hasFinraData,
          hasSecData: detail.hasSecData,
          finraNode: detail,
          sources: {
            finra: bcDetail,
            sec: secDetail,
          },
          merged: detail,
        },
        { headers: sharedCacheHeaders(1209600) },
      );
    }

    return NextResponse.json(detail, { headers: sharedCacheHeaders(1209600) });
  } catch (err: any) {
    logger.error("firm local detail route error", {
      id,
      error: err.message,
      stack: err.stack,
      isMergedRoute: request.nextUrl.searchParams.get("merged") === "1",
    });
    return NextResponse.json(
      { error: "Failed to load local detail.", message: err.message },
      { status: 500 },
    );
  }
}
