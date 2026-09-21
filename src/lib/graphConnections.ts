// Server-side firm connections for dashboard + graph sidebar.
// Display roster: Redis firm-connections:firm:{firmId} (curated CRD arrays / entries).
// Other sources (disk, broker-id mirrors, official search, primed adj) only backfill that key.
// Do not also write graph:firm-connections:v10:{firmId} — that duplicated the same roster payload.
// Note: the mono graph store's employed_by links (getFullGraph) were previously merged in as a
// connection source but have been removed — that artifact could carry stale/incorrect data
// forward independent of the individual's own record. Validation now comes exclusively from
// each individual's own cached current/previous employment history
// (see enrichConnectionEntriesFromIndividualCache / hasValidatedFirmConnectionEvidence below).
import {
  searchLocalIndex,
  hasMinimumSearchQuery,
  lookupLocalSearchHitsByIds,
} from "@/lib/localSearch";
import { searchGraphFallback } from "@/lib/searchGraphFallback";
import { searchDirectRedisFallback } from "@/lib/searchDirectFallback";
import { getFirmEmploymentEdgesFromFullScan } from "@/lib/firmEmploymentIndex";
import { lookupFirmEmploymentEdgesFromPrimed } from "@/lib/firmEmploymentFromPrimed";
import {
  getRedisClient,
  setStringIfValid,
  decompressPayload,
} from "@/lib/redisCache";
import { canWriteToRedis, isRedisCacheOnly } from "@/lib/redisAvailability";
import {
  fetchOfficialFirmRoster,
  isOfficialFirmRoster,
  OFFICIAL_FIRM_ROSTER_SOURCE,
} from "@/lib/officialFirmRoster";
import { buildPersonName } from "@/lib/nameFormat";

export type GraphConnectionEntry = {
  individualId?: string;
  firmId?: string;
  name: string;
  relationship: string;
  startDate?: string;
  endDate?: string;
  isCurrent: boolean;
  bcScope?: string;
  iaScope?: string;
  // Evidence tags describing why this connection was inferred (e.g. 'primed', 'graph-edge', 'search-finra')
  evidence?: string[];
  sourceTags?: string[];
  // Display enrichment from cached individual detail:
  otherNames?: string[];
  address?: string;
  statusTag?: "Broker" | "BD Stub Only" | "Inactive";
  /** Current employer for people on a firm's previous-connections list. */
  currentFirmId?: string;
  currentFirmName?: string;
};

const FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Do not stick empty results for an hour — empty caches were masking recoveries.
const EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// v10: do not treat a thin primed-bundle hit as the full roster (v9 poisoned mega-firms).
export const FIRM_CONNECTIONS_CACHE_VERSION = 10;

export function firmConnectionsCacheKey(firmId: string): string {
  return `firm-connections:firm:${String(firmId || "").trim()}`;
}

function leftoverFirmConnectionsCacheKeys(firmId: string): string[] {
  const normalized = String(firmId || "").trim();
  if (!normalized) return [];
  return [
    `graph:firm-connections:v${FIRM_CONNECTIONS_CACHE_VERSION}:${normalized}`,
    `graph:firm-connections:v${FIRM_CONNECTIONS_CACHE_VERSION}:${normalized}:empty`,
    `graph:firm-connections-verified:v${FIRM_CONNECTIONS_CACHE_VERSION}:${normalized}`,
  ];
}

async function dropLeftoverFirmConnectionsCacheKeys(redis: any, firmId: string) {
  if (!redis) return;
  for (const key of leftoverFirmConnectionsCacheKeys(firmId)) {
    try {
      await redis.del(key);
    } catch {
      // leftover keys are optional cleanup
    }
  }
}

// Once every connection entry for a firm carries validated per-firm employment evidence (see
// hasValidatedFirmConnectionEvidence()), the payload can never become "more validated" — there's
// nothing left to check. Cache it here, permanently (no TTL), so future requests for this firm
// skip the entire broker-id-mirror enrichment pipeline (which otherwise re-reads every
// individual's cached detail record from Redis on every single request) and return instantly
// from one GET. Only written once a firm reaches 100% validated; never written for partial
// results, so it can't mask newly-added unvalidated CRDs (a firm can only move from "not fully
// validated" -> "fully validated", never lose entries once this key exists, matching the
// project's additive-only mirror-key semantics).
function firmConnectionsFullyValidatedCacheKey(firmId: string): string {
  return `firm-connections:firm:${String(firmId || "").trim()}:verified`;
}

export function firmConnectionsVerifiedCacheKey(firmId: string): string {
  return firmConnectionsFullyValidatedCacheKey(firmId);
}

export function countFirmConnectionEntries(
  payload:
    | {
        currentConnections?: GraphConnectionEntry[];
        previousConnections?: GraphConnectionEntry[];
      }
    | null
    | undefined,
): number {
  if (!payload) return 0;
  return (
    (payload.currentConnections?.length || 0) +
    (payload.previousConnections?.length || 0)
  );
}

export function connectionEntryId(
  entry: GraphConnectionEntry | null | undefined,
): string {
  return firstNonEmpty(entry?.individualId, entry?.firmId, (entry as any)?.crd);
}

export function mergeGraphConnectionEntries(lists: GraphConnectionEntry[][]): {
  currentConnections: GraphConnectionEntry[];
  previousConnections: GraphConnectionEntry[];
} {
  const current: GraphConnectionEntry[] = [];
  const previous: GraphConnectionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of lists.flat()) {
    const id = connectionEntryId(entry);
    if (!id) continue;
    const kind = entry?.firmId && !entry?.individualId ? "firm" : "person";
    const dedupeKey = `${kind}:${id}:${entry.isCurrent ? "1" : "0"}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    (entry.isCurrent ? current : previous).push(entry);
  }
  return { currentConnections: current, previousConnections: previous };
}

function toArraySafe(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function nameTokenCount(name: string | undefined | null): number {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Prefer the candidate when it has more name tokens (or equal tokens but longer text). */
export function preferRicherPersonName(
  existing: string | undefined | null,
  candidate: string | undefined | null,
): string {
  const current = String(existing || "").trim();
  const next = String(candidate || "").trim();
  if (!next) return current;
  if (!current) return next;
  const currentTokens = nameTokenCount(current);
  const nextTokens = nameTokenCount(next);
  if (nextTokens > currentTokens) return next;
  if (nextTokens === currentTokens && next.length > current.length) return next;
  return current;
}

/** Build a full person display name from a cached individual detail payload. */
export function composeIndividualDisplayName(detail: any): string {
  const basic = detail?.basicInformation || detail || {};
  const composed = buildPersonName(
    basic?.firstName ?? detail?.firstName,
    basic?.middleName ?? detail?.middleName,
    basic?.lastName ?? detail?.lastName,
    basic?.suffix ?? detail?.suffix,
  );
  return firstNonEmpty(
    composed,
    basic?.fullName,
    basic?.individualName,
    basic?.name,
    detail?.name,
    detail?.personName,
    detail?.displayName,
  );
}

export function connectionNeedsDisplayEnrichment(
  entry: GraphConnectionEntry | null | undefined,
): boolean {
  if (!entry) return false;
  const displayChecked = entry.evidence?.includes("display-enriched");
  const name = String(entry.name || "").trim();
  if ((!name || nameTokenCount(name) < 2) && !displayChecked) return true;
  if (!String(entry.address || "").trim() && !displayChecked) return true;
  return false;
}

function composeAddressFromSearchHit(hit: any, preferFirmId?: string): string {
  const preferId = String(preferFirmId || "").trim();
  const employments = [
    ...(Array.isArray(hit?.ind_current_employments) ? hit.ind_current_employments : []),
    ...(Array.isArray(hit?.ind_ia_current_employments) ? hit.ind_ia_current_employments : []),
    ...(Array.isArray(hit?.ind_previous_employments) ? hit.ind_previous_employments : []),
    ...(Array.isArray(hit?.ind_ia_previous_employments) ? hit.ind_ia_previous_employments : []),
  ];
  const preferred =
    (preferId
      ? employments.find((row) => String(row?.firmId || row?.firm_id || "").trim() === preferId)
      : null) || employments[0];
  if (preferred) {
    const branch = Array.isArray(preferred?.branchOfficeLocations)
      ? preferred.branchOfficeLocations[0]
      : null;
    const city = String(branch?.city || preferred?.city || "").trim();
    const state = String(branch?.state || preferred?.state || "").trim();
    const zip = String(branch?.zipCode || preferred?.zipCode || "").trim();
    const line = [city, state].filter(Boolean).join(", ");
    if (line && zip) return `${line} ${zip}`;
    if (line) return line;
  }
  return String(hit?.addressSearchText || hit?.address || "").trim();
}

function composeNameFromSearchHit(hit: any): string {
  return firstNonEmpty(
    buildPersonName(hit?.ind_firstname, hit?.ind_middlename, hit?.ind_lastname),
    hit?.label,
    hit?.name,
    [hit?.ind_firstname, hit?.ind_middlename, hit?.ind_lastname].filter(Boolean).join(" "),
  );
}

/**
 * Fill thin firm-connection display fields from gzip search sidecars (no Redis detail GETs).
 * Safe for light=1 / mega-firm paths — indexes are process-local after first load.
 */
export async function hydrateFirmConnectionsFromSearchSidecar(
  payload: FirmConnectionsPayload,
  firmId?: string,
  options: { baseUrl?: string } = {},
): Promise<FirmConnectionsPayload> {
  const current = Array.isArray(payload?.currentConnections) ? payload.currentConnections : [];
  const previous = Array.isArray(payload?.previousConnections) ? payload.previousConnections : [];
  const needs = [...current, ...previous].filter(connectionNeedsDisplayEnrichment);
  if (!needs.length) return payload;

  const ids = Array.from(
    new Set(
      needs
        .map((entry) => String(entry.individualId || entry.firmId || "").trim())
        .filter((id) => /^\d{1,10}$/.test(id)),
    ),
  );
  if (!ids.length) return payload;

  const hits = new Map<string, any>();
  for (const source of ["finra", "sec"] as const) {
    const remaining = ids.filter((id) => !hits.has(id));
    if (!remaining.length) break;
    const batch = await lookupLocalSearchHitsByIds(source, "individual", remaining, {
      baseUrl: options.baseUrl,
    });
    for (const [id, hit] of batch) hits.set(id, hit);
  }
  if (!hits.size) return payload;

  const preferFirmId = String(firmId || "").trim();
  const hydrateEntry = (entry: GraphConnectionEntry): GraphConnectionEntry => {
    if (!connectionNeedsDisplayEnrichment(entry)) return entry;
    const crd = String(entry.individualId || "").trim();
    const hit = hits.get(crd);
    if (!hit) return entry;
    const name = preferRicherPersonName(entry.name, composeNameFromSearchHit(hit));
    const otherNames = Array.from(
      new Set(
        [
          ...(Array.isArray(entry.otherNames) ? entry.otherNames : []),
          ...(Array.isArray(hit.ind_other_names) ? hit.ind_other_names : []),
          ...(Array.isArray(hit.otherNames) ? hit.otherNames : []),
        ]
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
    const address = entry.address || composeAddressFromSearchHit(hit, preferFirmId) || undefined;
    const evidence = Array.from(
      new Set([...(entry.evidence || []), "sidecar-hydrated"].filter(Boolean)),
    );
    return {
      ...entry,
      name: name || entry.name,
      ...(otherNames.length ? { otherNames } : {}),
      ...(address ? { address } : {}),
      bcScope: entry.bcScope || hit.ind_bc_scope || undefined,
      iaScope: entry.iaScope || hit.ind_ia_scope || undefined,
      evidence,
    };
  };

  return {
    currentConnections: current.map(hydrateEntry),
    previousConnections: previous.map(hydrateEntry),
  };
}

/** Pick a current employer for previous-connection display (prefer not the firm being viewed). */
export function extractCurrentEmployerFromDetail(
  detail: any,
  excludeFirmId?: string,
): { currentFirmId?: string; currentFirmName?: string } {
  const employments = [
    ...toArraySafe(detail?.currentEmployments),
    ...toArraySafe(detail?.currentIAEmployments),
  ];
  if (!employments.length) return {};
  const excluded = String(excludeFirmId || "").trim();
  const match =
    employments.find((emp) => {
      const id = String(firstNonEmpty(emp?.firmId, emp?.firm_id, emp?.crdNumber, emp?.crd) || "").trim();
      return id && (!excluded || id !== excluded);
    }) ||
    employments.find((emp) =>
      Boolean(firstNonEmpty(emp?.firmId, emp?.firm_id, emp?.firmName, emp?.iaFirmName, emp?.name)),
    );
  if (!match) return {};
  const currentFirmId =
    String(firstNonEmpty(match?.firmId, match?.firm_id, match?.crdNumber, match?.crd) || "").trim() ||
    undefined;
  const currentFirmName =
    firstNonEmpty(
      match?.firmName,
      match?.iaFirmName,
      match?.legalName,
      match?.name,
      match?.organizationName,
    ) || undefined;
  if (!currentFirmId && !currentFirmName) return {};
  return { currentFirmId, currentFirmName };
}

async function searchIndividualsForFirmWithFallback(
  source: "finra" | "sec",
  firmId: string,
): Promise<any[]> {
  const limit = 30;
  let localHits: any[] = [];

  const local = await searchLocalIndex(source, "individual", firmId, {
    limit,
  }).catch(() => null);
  if (local && local.total > 0)
    localHits = localHits.concat(toArraySafe(local?.hits?.hits));

  if (localHits.length < limit && hasMinimumSearchQuery(firmId)) {
    const graphFallback = await searchGraphFallback(
      source,
      "individual",
      firmId,
      { limit },
    ).catch(() => null);
    if (graphFallback && graphFallback.total > 0)
      localHits = localHits.concat(toArraySafe(graphFallback?.hits?.hits));
  }

  if (localHits.length < limit && hasMinimumSearchQuery(firmId)) {
    const directFallback = await searchDirectRedisFallback(
      source,
      "individual",
      firmId,
      { limit },
    ).catch(() => null);
    if (directFallback && directFallback.hits?.total > 0)
      localHits = localHits.concat(toArraySafe(directFallback?.hits?.hits));
  }

  let extHits: any[] = [];
  // Always fetch external if we have fewer than 20 local hits to ensure completeness for fresh DBs
  if (localHits.length < 20) {
    try {
      const maxApiRows = 100; // Both FINRA and SEC hard-fail if > 100
      const extUrl =
        source === "finra"
          ? `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxApiRows}&includePrevious`
          : `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxApiRows}&includePrevious`;
      const extRes = await fetch(extUrl, { cache: "no-store" });
      const extData = await extRes.json();
      if (extData && extData.hits && extData.hits.total > 0) {
        extHits = toArraySafe(extData.hits.hits).map((hit: any) => {
          const sourceObj = hit?._source || hit || {};
          return {
            ...sourceObj,
            ind_previous_employments:
              hit?.inner_hits?.ind_previous_employments?.hits?.hits?.map(
                (h: any) => h._source,
              ) || [],
            ind_ia_previous_employments:
              hit?.inner_hits?.ind_ia_previous_employments?.hits?.hits?.map(
                (h: any) => h._source,
              ) || [],
            ind_current_employments:
              hit?.inner_hits?.ind_current_employments?.hits?.hits?.map(
                (h: any) => h._source,
              ) ||
              sourceObj.ind_current_employments ||
              [],
          };
        });
      }
    } catch (e) {
      // If external fetch is disabled or fails, try reading a local cached copy from data/national
      try {
        const fs = require("fs");
        const path = require("path");
        const candidates = [
          path.join(
            process.cwd(),
            "data",
            "national",
            `brokercheck.finra.org`,
            `api.brokercheck.finra.org_search_firm_${firmId}.json`,
          ),
          path.join(
            process.cwd(),
            "data",
            "national",
            `adviserinfo.sec.gov`,
            `api.adviserinfo.sec.gov_search_firm_${firmId}.json`,
          ),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf-8");
            let parsed: any = null;
            try {
              parsed = JSON.parse(raw);
            } catch (e2) {
              // Some files may wrap the payload; try to locate embedded JSON
              const m = raw.match(/\{\"hits\"[\s\S]*\}$/m);
              if (m) parsed = JSON.parse(m[0]);
            }
            if (parsed && parsed.hits && parsed.hits.hits) {
              extHits = toArraySafe(parsed.hits.hits).map((hit: any) => {
                const sourceObj = hit?._source || hit || {};
                return {
                  ...sourceObj,
                  ind_previous_employments:
                    hit?.inner_hits?.ind_previous_employments?.hits?.hits?.map(
                      (h: any) => h._source,
                    ) || [],
                  ind_ia_previous_employments:
                    hit?.inner_hits?.ind_ia_previous_employments?.hits?.hits?.map(
                      (h: any) => h._source,
                    ) || [],
                  ind_current_employments:
                    hit?.inner_hits?.ind_current_employments?.hits?.hits?.map(
                      (h: any) => h._source,
                    ) ||
                    sourceObj.ind_current_employments ||
                    [],
                };
              });
              if (extHits.length) break;
            }
          }
        }
      } catch {
        // swallow
      }
    }
  }

  // Merge all hits, map to source, and remove duplicates
  const merged = [
    ...localHits.map((h: any) => h?._source || h || {}),
    ...extHits,
  ];
  const seen = new Set<string>();
  return merged.filter((item: any) => {
    const id =
      item.ind_source_id || item.ind_crd || item.individualId || item.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function getConnectionsFromSearchIndex(
  firmId: string,
): Promise<GraphConnectionEntry[]> {
  const entries: GraphConnectionEntry[] = [];
  for (const source of ["finra", "sec"] as const) {
    try {
      const hits = await searchIndividualsForFirmWithFallback(source, firmId);
      for (const src of hits) {
        const crd = firstNonEmpty(
          src.ind_source_id,
          src.ind_crd,
          src.individualId,
          src.id,
        );
        if (!crd) continue;

        const name = firstNonEmpty(
          [src.ind_firstname, src.ind_middlename, src.ind_lastname]
            .filter(Boolean)
            .join(" "),
          src.individualName,
          src.name,
        );

        const currentEmployments = [
          ...toArraySafe(src.ind_current_employments),
          ...toArraySafe(src.currentEmployments),
          ...toArraySafe(src.currentIAEmployments),
        ];
        const previousEmployments = [
          ...toArraySafe(src.ind_previous_employments),
          ...toArraySafe(src.ind_ia_previous_employments),
          ...toArraySafe(src.previousEmployments),
          ...toArraySafe(src.previousIAEmployments),
        ];

        const matchedCurrent = currentEmployments.find(
          (e: any) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId,
        );
        if (matchedCurrent) {
          entries.push({
            individualId: crd,
            name,
            relationship: "Current registration",
            startDate:
              firstNonEmpty(
                matchedCurrent?.registrationBeginDate,
                matchedCurrent?.startDate,
              ) || undefined,
            endDate: undefined,
            isCurrent: true,
            evidence: [`search-${source}`, "current-employment-record"],
          });
          continue;
        }

        const matchedPrevious = previousEmployments.find(
          (e: any) => firstNonEmpty(e?.firmId, e?.firm_id) === firmId,
        );
        if (matchedPrevious) {
          entries.push({
            individualId: crd,
            name,
            relationship: "Previous registration",
            startDate:
              firstNonEmpty(
                matchedPrevious?.registrationBeginDate,
                matchedPrevious?.startDate,
              ) || undefined,
            endDate:
              firstNonEmpty(
                matchedPrevious?.registrationEndDate,
                matchedPrevious?.endDate,
              ) || undefined,
            isCurrent: false,
            evidence: [`search-${source}`, "matched-previous-employment"],
          });
          continue;
        }

        // Do NOT assume a search hit is a valid connection just because the search API
        // returned it (it may have matched on a firm-name token rather than this exact
        // firm CRD, or on stale/expired data). A connection is only valid when this
        // person's own employment record actually references the firm CRD — skip
        // unverifiable hits rather than guessing (previously caused false-positive
        // "previous connections", e.g. firm 343750 showing 47 unrelated people).
      }
    } catch {
      // Best-effort
    }
  }
  return entries;
}

// Pulls the individual's alternate/nickname list (basicInformation.otherNames or the top-level
// mirror of the same array) so cards can show "Other names" alongside the legal name.
function extractOtherNames(node: any): string[] | undefined {
  const raw = toArraySafe(node?.otherNames).length
    ? node.otherNames
    : toArraySafe(node?.basicInformation?.otherNames);
  const names = raw
    .map((n: unknown) =>
      String(n || "")
        .trim()
        .replace(/\s+/g, " "),
    )
    .filter(Boolean);
  return names.length ? Array.from(new Set(names)) : undefined;
}

// Best-effort branch office address for this specific firm relationship (falls back to any
// available employment record if the firmId-specific one isn't found).
function extractPrimaryAddress(node: any, firmId: string): string | undefined {
  const employments = [
    ...toArraySafe(node?.currentEmployments),
    ...toArraySafe(node?.currentIAEmployments),
    ...toArraySafe(node?.previousEmployments),
    ...toArraySafe(node?.previousIAEmployments),
  ];
  const match =
    employments.find(
      (entry) =>
        String(firstNonEmpty(entry?.firmId, entry?.firm_id)) === String(firmId),
    ) || employments[0];
  if (!match) return undefined;
  // Some employment shapes carry a nested branchOfficeLocations[] (camelCase, from
  // FINRA/SEC detail payloads), others carry flat branch_city/branch_state/branch_zip
  // fields directly on the employment record (from search-index/graph-merge shapes).
  const branch = toArraySafe(match?.branchOfficeLocations)[0] || match;
  const city = firstNonEmpty(
    branch?.city,
    match?.branch_city,
    match?.branchCity,
  );
  const state = firstNonEmpty(
    branch?.state,
    match?.branch_state,
    match?.branchState,
  );
  const zip = firstNonEmpty(
    branch?.zipCode,
    branch?.zip,
    match?.branch_zip,
    match?.branchZip,
  );
  const street = firstNonEmpty(
    branch?.street1,
    branch?.street,
    match?.branch_address,
    match?.branchAddress,
    match?.address,
  );
  const parts = [street, [city, state].filter(Boolean).join(", "), zip].filter(
    Boolean,
  );
  return parts.length ? parts.join(" ") : undefined;
}

// Classifies a connection as an actively-registered "Broker", a firm-affiliated but
// non-registered/sparse "BD Stub Only" record, or "Inactive" (no active registration/scope).
// Mirrors the bcScope/iaScope-driven activity signals used by isNodeInactive() in finra-graph.ts,
// but is distinct because it also considers whether the person still has an active employment
// record at this specific firm.
function computeConnectionStatusTag(
  node: any,
  currentEmployments: any[],
  isCurrent: boolean,
): GraphConnectionEntry["statusTag"] {
  const bcScope = String(
    firstNonEmpty(node?.bcScope, node?.basicInformation?.bcScope) || "",
  ).toLowerCase();
  const iaScope = String(
    firstNonEmpty(node?.iaScope, node?.basicInformation?.iaScope) || "",
  ).toLowerCase();
  const hasActiveScope =
    bcScope.includes("active") || iaScope.includes("active");
  if (hasActiveScope && isCurrent) return "Broker";
  if (isCurrent && currentEmployments.length > 0) return "BD Stub Only";
  return "Inactive";
}

async function getConnectionsFromPrimedBundle(firmId: string): Promise<{
  entries: GraphConnectionEntry[];
  source: "adj" | "bundle" | "none";
}> {
  const lookup = await lookupFirmEmploymentEdgesFromPrimed(firmId).catch(
    () => ({ edges: [], source: "none" as const }),
  );
  return {
    source: lookup.source,
    entries: lookup.edges.map((edge) => ({
      individualId: edge.personCrd,
      name: edge.personName,
      relationship: edge.isCurrent
        ? "Current registration"
        : "Previous registration",
      startDate: edge.startDate,
      endDate: edge.isCurrent ? undefined : edge.endDate,
      isCurrent: edge.isCurrent,
      evidence: [lookup.source === "adj" ? "firm-emp-adj" : "primed-bundle"],
      bcScope: edge.bcScope,
      iaScope: edge.iaScope,
    })),
  };
}

type FirmConnectionsPayload = {
  currentConnections: GraphConnectionEntry[];
  previousConnections: GraphConnectionEntry[];
  source?: string;
  officialTotals?: { finra?: number; sec?: number };
  fetchedAt?: string;
};

function connectionEntryFromCachedValue(
  value: unknown,
  isCurrent: boolean,
): GraphConnectionEntry | null {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string") {
    const individualId = String(value).trim();
    if (!/^\d{1,10}$/.test(individualId)) return null;
    return {
      individualId,
      name: "",
      relationship: isCurrent ? "Current registration" : "Previous registration",
      isCurrent,
    };
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const individualId = firstNonEmpty(
    record.individualId,
    record.crd,
    record.personId,
    record.id,
  );
  if (!individualId) return null;
  return {
    ...(record as GraphConnectionEntry),
    individualId,
    name: String(record.name || "").trim(),
    relationship:
      String(record.relationship || "").trim() ||
      (isCurrent ? "Current registration" : "Previous registration"),
    isCurrent,
  };
}

function normalizeCachedConnectionList(
  list: unknown,
  isCurrent: boolean,
): GraphConnectionEntry[] {
  if (!Array.isArray(list)) return [];
  const out: GraphConnectionEntry[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const entry = connectionEntryFromCachedValue(value, isCurrent);
    const id = connectionEntryId(entry);
    if (!entry || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

function parseCachedConnectionsPayload(
  raw: unknown,
): FirmConnectionsPayload | null {
  if (raw == null) return null;
  let data: any = raw;
  if (typeof data === "string") {
    try {
      const text = data.startsWith("br:") ? decompressPayload(data) : data;
      data = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) {
    return {
      currentConnections: normalizeCachedConnectionList(data, true),
      previousConnections: [],
    };
  }
  if (!data || typeof data !== "object") return null;
  const currentConnections = normalizeCachedConnectionList(
    data.currentConnections ?? data.current ?? data.currentIds ?? data.connected,
    true,
  );
  const previousConnections = normalizeCachedConnectionList(
    data.previousConnections ?? data.previous ?? data.previousIds,
    false,
  );
  return {
    currentConnections,
    previousConnections,
    source: typeof data.source === "string" ? data.source : undefined,
    officialTotals:
      data.officialTotals && typeof data.officialTotals === "object"
        ? data.officialTotals
        : undefined,
    fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : undefined,
  };
}

async function getConnectionsFromFullScanIndex(
  firmId: string,
): Promise<GraphConnectionEntry[]> {
  const edges = await getFirmEmploymentEdgesFromFullScan(firmId).catch(
    () => [],
  );
  return edges.map((edge) => ({
    individualId: edge.personCrd,
    name: edge.personName,
    relationship: edge.isCurrent
      ? "Current registration"
      : "Previous registration",
    startDate: edge.startDate,
    endDate: edge.isCurrent ? undefined : edge.endDate,
    isCurrent: edge.isCurrent,
  }));
}

async function computeFirmConnectionsFromGraph(
  firmId: string,
): Promise<FirmConnectionsPayload> {
  const official = await fetchOfficialFirmRoster(firmId).catch(() => null);
  if (official && countFirmConnectionEntries(official) > 0) return official;

  // Cheap → expensive fallbacks when official search is unavailable.
  // Trust precomputed adj as complete. A primed-bundle hit is only the people
  // present in that snapshot — never treat a 1-person bundle match as the roster.
  const primed = await getConnectionsFromPrimedBundle(firmId).catch(() => ({
    entries: [] as GraphConnectionEntry[],
    source: "none" as const,
  }));
  if (primed.source === "adj")
    return mergeGraphConnectionEntries([primed.entries]);

  // Search can hang on cold indexes; bound it so firm pages don't 504.
  const searchEntries = await Promise.race([
    getConnectionsFromSearchIndex(firmId).catch(
      () => [] as GraphConnectionEntry[],
    ),
    new Promise<GraphConnectionEntry[]>((resolve) =>
      setTimeout(() => resolve([]), 8000),
    ),
  ]);
  if (searchEntries.length || primed.entries.length)
    return mergeGraphConnectionEntries([primed.entries, searchEntries]);

  const fullScanEntries = await getConnectionsFromFullScanIndex(firmId).catch(
    () => [] as GraphConnectionEntry[],
  );
  return mergeGraphConnectionEntries([fullScanEntries]);
}

function readLocalFirmConnectionsFile(firmId: string): {
  payload: FirmConnectionsPayload | null;
  path: string;
} {
  const fs = require("fs");
  const path = require("path");
  const localCachePath = path.join(
    process.cwd(),
    "data",
    "firm-connections",
    `${firmId}.json`,
  );
  try {
    fs.mkdirSync(path.dirname(localCachePath), { recursive: true });
    if (fs.existsSync(localCachePath)) {
      const localHit = parseCachedConnectionsPayload(
        fs.readFileSync(localCachePath, "utf-8"),
      );
      if (localHit && countFirmConnectionEntries(localHit) > 0) {
        return { payload: localHit, path: localCachePath };
      }
    }
  } catch {
    // fallback to compute
  }
  return { payload: null, path: localCachePath };
}

// Determine which upstream source(s) validated a connection entry from its evidence tags
// (e.g. 'search-finra', 'official-search-sec', 'matched-previous-employment' — the latter
// carries no source on its own, so we look at the sibling tag emitted alongside it).
function evidenceSources(entry: GraphConnectionEntry): Array<"finra" | "sec"> {
  const tags = Array.isArray(entry.evidence) ? entry.evidence : [];
  const sources = new Set<"finra" | "sec">();
  for (const tag of tags) {
    if (/finra/i.test(tag)) sources.add("finra");
    if (/sec/i.test(tag)) sources.add("sec");
  }
  // Fall back to bcScope/iaScope presence when evidence tags are ambiguous/missing.
  if (!sources.size) {
    if (entry.bcScope) sources.add("finra");
    if (entry.iaScope) sources.add("sec");
  }
  return sources.size ? Array.from(sources) : ["finra", "sec"];
}

// Recognized evidence tags that actually prove this individual's own employment record
// references the firm CRD in question (i.e. a real, verified connection to this specific
// firm, not just a name/token match or an unverifiable search hit). Anything without one
// of these tags — including stale 'implicit-previous-match' entries persisted by the old,
// removed fallback logic in getConnectionsFromSearchIndex() — must be excluded from the
// shared broker-id mirror keys.
const VALID_FIRM_CONNECTION_EVIDENCE = new Set([
  "current-employment-record",
  "matched-previous-employment",
  "firm-emp-adj",
  "primed-bundle",
]);

function hasValidatedFirmConnectionEvidence(
  entry: GraphConnectionEntry,
): boolean {
  const tags = Array.isArray(entry.evidence) ? entry.evidence : [];
  return tags.some((tag) => VALID_FIRM_CONNECTION_EVIDENCE.has(tag));
}

export type IndividualEmployerLink = {
  firmId: string;
  firmName?: string;
  startDate?: string;
  endDate?: string;
  isCurrent: boolean;
  sources: Array<"finra" | "sec">;
};

const MAX_EMPLOYER_FIRMS_PER_INDIVIDUAL_UPSERT = 80;

export function extractIndividualEmployerLinksFromDetail(
  detail: any,
): IndividualEmployerLink[] {
  if (!detail || typeof detail !== "object") return [];

  type Acc = {
    firmId: string;
    firmName?: string;
    startDate?: string;
    endDate?: string;
    isCurrent: boolean;
    sources: Set<"finra" | "sec">;
  };
  const byFirm = new Map<string, Acc>();

  const ingest = (
    rows: unknown,
    isCurrent: boolean,
    source: "finra" | "sec",
  ) => {
    for (const row of toArraySafe(rows)) {
      if (!row || typeof row !== "object") continue;
      const firmId = firstNonEmpty(
        (row as any).firmId,
        (row as any).firm_id,
        (row as any).organizationCrd,
      );
      if (!firmId || !/^\d{1,10}$/.test(firmId)) continue;
      const firmName = firstNonEmpty(
        (row as any).firmName,
        (row as any).firm_name,
        (row as any).name,
      );
      const startDate = firstNonEmpty(
        (row as any).registrationBeginDate,
        (row as any).effectiveDate,
        (row as any).startDate,
        (row as any).fromDate,
      );
      const endDate = firstNonEmpty(
        (row as any).registrationEndDate,
        (row as any).endDate,
        (row as any).toDate,
      );
      const existing = byFirm.get(firmId);
      if (!existing) {
        byFirm.set(firmId, {
          firmId,
          firmName: firmName || undefined,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          isCurrent,
          sources: new Set([source]),
        });
        continue;
      }
      existing.sources.add(source);
      if (firmName && !existing.firmName) existing.firmName = firmName;
      if (startDate && !existing.startDate) existing.startDate = startDate;
      if (endDate && !existing.endDate) existing.endDate = endDate;
      // Current wins when the same firm appears in both buckets.
      if (isCurrent) {
        existing.isCurrent = true;
        existing.endDate = undefined;
      }
    }
  };

  ingest(detail.currentEmployments, true, "finra");
  ingest(detail.currentIAEmployments, true, "sec");
  ingest(detail.previousEmployments, false, "finra");
  ingest(detail.previousIAEmployments, false, "sec");

  return Array.from(byFirm.values())
    .slice(0, MAX_EMPLOYER_FIRMS_PER_INDIVIDUAL_UPSERT)
    .map((entry) => ({
      firmId: entry.firmId,
      firmName: entry.firmName,
      startDate: entry.startDate,
      endDate: entry.isCurrent ? undefined : entry.endDate,
      isCurrent: entry.isCurrent,
      sources: Array.from(entry.sources),
    }));
}


export type UpsertIndividualEmployerOptions = {
  /** Skip Redis/disk writes when the person is already in the correct current/previous bucket. Default true. */
  skipUnchanged?: boolean;
  /** Extra evidence tag for the write path (default individual-detail-load). */
  evidenceTag?: string;
  /** Cap how many employer firms may be written in one call. */
  maxFirmWrites?: number;
};

/**
 * Page-load firm-connections update: when an individual detail page/API loads, treat that
 * person's employment history as the source of truth and upsert them into each employer firm's
 * Redis firm-connections roster. Official firm-by-individual search is incomplete for many
 * older/low firm CRDs; reverse links from person detail close that gap.
 */
export async function upsertIndividualIntoEmployerFirmConnections(
  crd: string,
  detail: any,
  options: UpsertIndividualEmployerOptions = {},
): Promise<{ firmsTouched: string[]; firmsSkippedUnchanged: string[] }> {
  const normalizedCrd = String(crd || "").trim();
  if (!normalizedCrd || !/^\d{1,10}$/.test(normalizedCrd)) {
    return { firmsTouched: [], firmsSkippedUnchanged: [] };
  }

  if (!canWriteToRedis()) {
    return { firmsTouched: [], firmsSkippedUnchanged: [] };
  }
  const redis = getRedisClient();
  if (!redis) {
    return { firmsTouched: [], firmsSkippedUnchanged: [] };
  }

  const links = extractIndividualEmployerLinksFromDetail(detail).slice(
    0,
    Math.max(1, Math.min(80, Number(options.maxFirmWrites) || 25)),
  );
  if (!links.length) {
    return { firmsTouched: [], firmsSkippedUnchanged: [] };
  }

  // Never prefer firstName alone — that produced connection cards like "Susan" for Susan F Axelrod.
  const personName =
    composeIndividualDisplayName(detail) || `Individual ${normalizedCrd}`;

  const firmsTouched: string[] = [];
  const firmsSkippedUnchanged: string[] = [];

  for (const link of links) {
    const firmId = String(link.firmId || "").trim();
    if (!firmId || !/^\d{1,10}$/.test(firmId)) continue;

    const cacheKey = firmConnectionsCacheKey(firmId);
    const raw = await redis.get(cacheKey).catch(() => null);
    const payload = parseCachedConnectionsPayload(raw) ?? {
      currentConnections: [],
      previousConnections: [],
    };

    const currentById = new Map(
      (payload.currentConnections || []).map((entry) => [
        String(connectionEntryId(entry)),
        entry,
      ]),
    );
    const previousById = new Map(
      (payload.previousConnections || []).map((entry) => [
        String(connectionEntryId(entry)),
        entry,
      ]),
    );

    const evidence = [
      link.isCurrent ? "current-employment-record" : "matched-previous-employment",
      options.evidenceTag || "individual-detail-load",
    ];
    const currentEmployer = link.isCurrent
      ? {}
      : extractCurrentEmployerFromDetail(detail, firmId);
    const incoming: GraphConnectionEntry = {
      individualId: normalizedCrd,
      name: personName,
      relationship: link.isCurrent
        ? "Current registration"
        : "Previous registration",
      startDate: link.startDate || undefined,
      endDate: link.isCurrent ? undefined : link.endDate || undefined,
      isCurrent: link.isCurrent,
      evidence,
      sourceTags: ["redis-upsert"],
      bcScope: detail?.bcScope || undefined,
      iaScope: detail?.iaScope || undefined,
      ...(currentEmployer.currentFirmId
        ? { currentFirmId: currentEmployer.currentFirmId }
        : {}),
      ...(currentEmployer.currentFirmName
        ? { currentFirmName: currentEmployer.currentFirmName }
        : {}),
    };

    const mergeConnectionEntry = (
      existing: GraphConnectionEntry | undefined,
      next: GraphConnectionEntry,
    ): GraphConnectionEntry => {
      if (!existing) return next;
      const mergedEvidence = Array.from(
        new Set([...(existing.evidence || []), ...(next.evidence || [])].filter(Boolean)),
      );
      const mergedSourceTags = Array.from(
        new Set([...(existing.sourceTags || []), ...(next.sourceTags || [])].filter(Boolean)),
      );
      return {
        ...existing,
        ...next,
        name: preferRicherPersonName(existing.name, next.name),
        address: next.address || existing.address,
        otherNames: next.otherNames?.length ? next.otherNames : existing.otherNames,
        statusTag: next.statusTag || existing.statusTag,
        bcScope: next.bcScope || existing.bcScope,
        iaScope: next.iaScope || existing.iaScope,
        currentFirmId: next.currentFirmId || existing.currentFirmId,
        currentFirmName: next.currentFirmName || existing.currentFirmName,
        evidence: mergedEvidence,
        sourceTags: mergedSourceTags,
      };
    };

    if (link.isCurrent) {
      const existing = currentById.get(normalizedCrd);
      previousById.delete(normalizedCrd);
      const entry = mergeConnectionEntry(existing, incoming);
      if (
        options.skipUnchanged !== false &&
        existing &&
        existing.name === entry.name &&
        existing.address === entry.address &&
        existing.startDate === entry.startDate &&
        existing.endDate === entry.endDate &&
        existing.isCurrent === entry.isCurrent
      ) {
        firmsSkippedUnchanged.push(firmId);
        continue;
      }
      currentById.set(normalizedCrd, entry);
    } else {
      const existing = previousById.get(normalizedCrd);
      currentById.delete(normalizedCrd);
      const entry = mergeConnectionEntry(existing, incoming);
      if (
        options.skipUnchanged !== false &&
        existing &&
        existing.name === entry.name &&
        existing.address === entry.address &&
        existing.startDate === entry.startDate &&
        existing.endDate === entry.endDate &&
        existing.isCurrent === entry.isCurrent
      ) {
        firmsSkippedUnchanged.push(firmId);
        continue;
      }
      previousById.set(normalizedCrd, entry);
    }

    const nextPayload: FirmConnectionsPayload = {
      currentConnections: Array.from(currentById.values()),
      previousConnections: Array.from(previousById.values()),
      source: payload.source || "individual-detail-upsert",
      fetchedAt: new Date().toISOString(),
    };

    const localPath = require("path").join(
      process.cwd(),
      "data",
      "firm-connections",
      `${firmId}.json`,
    );
    await persistFirmConnections(nextPayload, cacheKey, `${cacheKey}:empty`, localPath, firmId);
    firmsTouched.push(firmId);
  }

  return { firmsTouched, firmsSkippedUnchanged };
}

async function persistFirmConnections(
  payload: FirmConnectionsPayload,
  cacheKey: string,
  emptyCacheKey: string,
  localPath: string,
  firmId?: string,
) {
  try {
    const json = JSON.stringify(payload);
    await setStringIfValid(cacheKey, json, FIRM_CONNECTIONS_CACHE_TTL_SECONDS);

    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, json + "\n");

    if (countFirmConnectionEntries(payload) === 0) {
      try {
        await setStringIfValid(emptyCacheKey, "1", EMPTY_FIRM_CONNECTIONS_CACHE_TTL_SECONDS);
      } catch {
        // empty result marker is optional
      }
    }
  } catch {
    // swallow write failures; the read path still works without the generated roster update
  }
}

// Unwraps the raw cached finra:individual:<crd>/sec:individual:<crd> payload, which is stored
// as the FINRA/SEC search API's response envelope ({hits:{hits:[{_source:{content:"..."}}]}})
// rather than a flat detail object — mirrors parseDetailPayload() in the individual detail route.
export function unwrapCachedIndividualDetail(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return null;
  const hit = parsed?.hits?.hits?.[0]?._source;
  const raw =
    hit?.content ??
    hit?.iacontent ??
    hit?.bccontent ??
    parsed?.content ??
    parsed?.iacontent ??
    parsed?.bccontent;
  if (raw != null) {
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }
  // Already a flat detail object (e.g. from an older cache write shape).
  if (parsed?.basicInformation || parsed?.individualId || parsed?.bcScope)
    return parsed;
  return null;
}

// Fills in name/otherNames/address/statusTag for connection entries (current or previous) that the
// broker-id-mirror + graph-store merge couldn't resolve (e.g. person not yet hydrated into
// the mono graph). Reads only from already-cached finra:individual:<crd>/sec:individual:<crd>
// Redis keys — never triggers an external FINRA/SEC fetch, so it stays fast and respects the
// local-dev external-fetch gate. Bounded to a small batch per call to avoid large Redis scans.
async function enrichConnectionEntriesFromIndividualCache(
  entries: GraphConnectionEntry[],
  firmId: string,
  redis: ReturnType<typeof getRedisClient>,
  options: { displayIncompleteOnly?: boolean; maxLookups?: number } = {},
): Promise<GraphConnectionEntry[]> {
  if (!redis || !entries.length) return entries;
  const MAX_LOOKUPS = Math.max(1, Math.min(2000, Number(options.maxLookups) || 400));
  // displayIncompleteOnly: cheap path for Redis rosters that already exist but have thin
  // display fields (first-name-only / missing address). Full path also re-checks validation.
  const needsEnrichment = entries
    .filter((entry) => {
      if (!entry.individualId) return false;
      if (options.displayIncompleteOnly) return connectionNeedsDisplayEnrichment(entry);
      return (
        connectionNeedsDisplayEnrichment(entry) ||
        !entry.statusTag ||
        !hasValidatedFirmConnectionEvidence(entry) ||
        !entry.evidence?.includes("display-enriched")
      );
    })
    .slice(0, MAX_LOOKUPS);
  if (!needsEnrichment.length) return entries;

  const detailById = new Map<string, any>();
  const parseCachedDetail = (raw: unknown) => {
    if (raw == null) return null;
    const text =
      typeof raw === "string" && raw.startsWith("br:")
        ? decompressPayload(raw)
        : raw;
    const rawParsed = typeof text === "string" ? JSON.parse(text) : text;
    return unwrapCachedIndividualDetail(rawParsed);
  };
  const mergeCachedDetails = (details: any[]) => {
    if (!details.length) return null;
    if (details.length === 1) return details[0];
    const otherNames = Array.from(
      new Set(
        details.flatMap((detail) => extractOtherNames(detail) || []),
      ),
    );
    return {
      ...details[0],
      ...details[1],
      basicInformation: {
        ...(details[0]?.basicInformation || {}),
        ...(details[1]?.basicInformation || {}),
      },
      currentEmployments: details.flatMap((detail) =>
        toArraySafe(detail?.currentEmployments),
      ),
      previousEmployments: details.flatMap((detail) =>
        toArraySafe(detail?.previousEmployments),
      ),
      currentIAEmployments: details.flatMap((detail) =>
        toArraySafe(detail?.currentIAEmployments),
      ),
      previousIAEmployments: details.flatMap((detail) =>
        toArraySafe(detail?.previousIAEmployments),
      ),
      otherNames,
    };
  };
  // Batch all lookups into two mget calls (one per source) instead of one GET pair
  // per entry — this turns up to MAX_LOOKUPS*2 sequential round-trips into 2 total.
  const crds = needsEnrichment.map((entry) => entry.individualId!);
  const finraKeys = crds.map((crd) => `finra:individual:${crd}`);
  const secKeys = crds.map((crd) => `sec:individual:${crd}`);
  let finraRaws: unknown[] = [];
  let secRaws: unknown[] = [];
  try {
    [finraRaws, secRaws] = await Promise.all([
      finraKeys.length ? redis.mget(...finraKeys).catch(() => new Array(finraKeys.length).fill(null)) : Promise.resolve([]),
      secKeys.length ? redis.mget(...secKeys).catch(() => new Array(secKeys.length).fill(null)) : Promise.resolve([]),
    ]);
  } catch {
    finraRaws = new Array(finraKeys.length).fill(null);
    secRaws = new Array(secKeys.length).fill(null);
  }
  crds.forEach((crd, index) => {
    try {
      const details = [
        parseCachedDetail(finraRaws[index]),
        parseCachedDetail(secRaws[index]),
      ].filter(Boolean);
      const detail = mergeCachedDetails(details);
      if (detail) detailById.set(crd, detail);
    } catch {
      // best-effort; leave entry as-is
    }
  });

  const attemptedIds = new Set(
    needsEnrichment.map((entry) => String(entry.individualId || "").trim()).filter(Boolean),
  );
  if (!detailById.size && !attemptedIds.size) return entries;

  return entries.map((entry) => {
    const detail = entry.individualId
      ? detailById.get(entry.individualId)
      : undefined;
    if (!detail) {
      // Only mark cache-miss completion for entries we actually attempted to look up.
      if (!attemptedIds.has(String(entry.individualId || "").trim())) return entry;
      const evidence = [...(entry.evidence || [])];
      if (!evidence.includes("display-enriched")) evidence.push("display-enriched");
      if (entry.isCurrent === false && !evidence.includes("curr-employer-enriched")) {
        evidence.push("curr-employer-enriched");
      }
      return { ...entry, evidence };
    }
    const basic = detail?.basicInformation || detail || {};
    // Upgrade thin names ("Susan") when the cached detail has a fuller composed name.
    const name = preferRicherPersonName(entry.name, composeIndividualDisplayName(detail));
    const bcScope =
      firstNonEmpty(entry.bcScope, detail?.bcScope, basic?.bcScope) ||
      undefined;
    const iaScope =
      firstNonEmpty(entry.iaScope, detail?.iaScope, basic?.iaScope) ||
      undefined;
    const otherNames = entry.otherNames?.length
      ? entry.otherNames
      : extractOtherNames(detail);
    const address = entry.address || extractPrimaryAddress(detail, firmId);
    const currentEmployments = [
      ...toArraySafe(detail?.currentEmployments),
      ...toArraySafe(detail?.currentIAEmployments),
    ];
    const previousEmployments = [
      ...toArraySafe(detail?.previousEmployments),
      ...toArraySafe(detail?.previousIAEmployments),
    ];
    const matchedEmployment = [
      ...currentEmployments,
      ...previousEmployments,
    ].find(
      (emp) =>
        String(firstNonEmpty(emp?.firmId, emp?.firm_id)) === String(firmId),
    );
    const startDate =
      entry.startDate ||
      firstNonEmpty(
        matchedEmployment?.registrationBeginDate,
        matchedEmployment?.startDate,
      ) ||
      undefined;
    const endDate = !entry.isCurrent
      ? entry.endDate ||
        firstNonEmpty(
          matchedEmployment?.registrationEndDate,
          matchedEmployment?.endDate,
        ) ||
        undefined
      : undefined;
    const statusTag =
      entry.statusTag ||
      computeConnectionStatusTag(
        { ...detail, bcScope, iaScope },
        currentEmployments,
        entry.isCurrent,
      );
    // Add the real validation evidence tag now that we've proven (or disproven) this entry
    // against the individual's own cached detail record — without this, an entry that's
    // merely name-enriched (not proven) could never count toward "fully validated" for the
    // firm-level fast-path cache below.
    const provenTag = matchedEmployment
      ? entry.isCurrent
        ? "current-employment-record"
        : "matched-previous-employment"
      : undefined;
    const evidence =
      provenTag && !entry.evidence?.includes(provenTag)
        ? [...(entry.evidence || []), provenTag]
        : [...(entry.evidence || [])];
    if (!evidence.includes("display-enriched")) evidence.push("display-enriched");

    let currentFirmId = entry.currentFirmId;
    let currentFirmName = entry.currentFirmName;
    if (entry.isCurrent === false) {
      const currentEmployer = extractCurrentEmployerFromDetail(detail, firmId);
      currentFirmId = currentFirmId || currentEmployer.currentFirmId;
      currentFirmName = currentFirmName || currentEmployer.currentFirmName;
      if (!evidence.includes("curr-employer-enriched")) evidence.push("curr-employer-enriched");
    }

    return {
      ...entry,
      name: name || entry.name,
      bcScope,
      iaScope,
      otherNames,
      address,
      startDate,
      endDate,
      statusTag,
      evidence,
      ...(currentFirmId ? { currentFirmId } : {}),
      ...(currentFirmName ? { currentFirmName } : {}),
      __employmentChecked: true,
      __employmentMatched: !!matchedEmployment,
    } as GraphConnectionEntry;
  });
}

// Drops broker-id-mirror entries whose own cached detail record was just fetched (in
// enrichConnectionEntriesFromIndividualCache) and does NOT list this firm as a current/previous
// employer. Additive only: never shrink Redis `firm-connections:firm:` rosters.
// keys (e.g. left over from a prior firmId typo, a since-corrected employment record, or manual
// backfill error) — real per-firm employment evidence disproves them outright. Entries whose
// detail wasn't cached (so membership couldn't be checked either way) are left untouched, since
// we can't prove them wrong.
async function attachConnectionDisplayFields(
  payload: FirmConnectionsPayload,
  firmId: string,
  redis: ReturnType<typeof getRedisClient>,
  options: { displayIncompleteOnly?: boolean; maxLookups?: number } = {},
): Promise<FirmConnectionsPayload> {
  if (!payload) return { currentConnections: [], previousConnections: [] };
  const currentConnections = await enrichConnectionEntriesFromIndividualCache(
    payload.currentConnections || [],
    firmId,
    redis,
    options,
  );
  const previousConnections = await enrichConnectionEntriesFromIndividualCache(
    payload.previousConnections || [],
    firmId,
    redis,
    options,
  );
  const stripInternalMarkers = (entries: GraphConnectionEntry[]) =>
    entries.map(({ __employmentChecked, __employmentMatched, ...rest }: any) => rest as GraphConnectionEntry);
  return {
    ...payload,
    currentConnections: stripInternalMarkers(currentConnections),
    previousConnections: stripInternalMarkers(previousConnections),
  };
}

function firmConnectionsDisplayFingerprint(payload: FirmConnectionsPayload): string {
  const rows = [
    ...(payload.currentConnections || []),
    ...(payload.previousConnections || []),
  ].map((entry) =>
    [
      entry.individualId || "",
      entry.name || "",
      entry.address || "",
      entry.statusTag || "",
      entry.currentFirmId || "",
      entry.currentFirmName || "",
      (entry.otherNames || []).join("|"),
      entry.evidence?.includes("curr-employer-enriched") ? "1" : "0",
    ].join("\t"),
  );
  return rows.join("\n");
}

export async function getFirmConnectionsFromGraph(
  firmId: string,
  options?: { computeIfMissing?: boolean; skipEnrichment?: boolean },
): Promise<FirmConnectionsPayload> {
  const normalizedFirmId = String(firmId || "").trim();
  if (!normalizedFirmId)
    return { currentConnections: [], previousConnections: [] };

  // Never write empty payloads to the long-TTL key (that poisoned firm people lists).
  const cacheKey = firmConnectionsCacheKey(normalizedFirmId);
  const emptyCacheKey = `${cacheKey}:empty`;
  const redis = getRedisClient();
  const skipEnrichment = Boolean(options?.skipEnrichment);

  const readRedisFirmConnections = async (): Promise<FirmConnectionsPayload | null> => {
    if (!redis) return null;
    try {
      const raw = await redis.get(cacheKey);
      if (raw == null) return null;
      const parsed = parseCachedConnectionsPayload(raw);
      if (parsed && countFirmConnectionEntries(parsed) > 0) {
        return parsed;
      }
    } catch {
      // fall through
    }
    return null;
  };

  const local = readLocalFirmConnectionsFile(normalizedFirmId);
  const redisRoster = await readRedisFirmConnections();

  // Display roster is Redis `firm-connections:firm:{id}` only. Disk / official search /
  // graph expand may backfill that key from scripts (`computeIfMissing`), but they must
  // not add people to the dashboard or sidebar on their own.
  if (redisRoster && countFirmConnectionEntries(redisRoster) > 0) {
    // Gzip search-sidecar hydration is cheap (no Redis GETs). light=1 still uses it; only
    // the Redis individual-detail enrichment pass below is skipped.
    const sidecarHydrated = await hydrateFirmConnectionsFromSearchSidecar(
      redisRoster,
      normalizedFirmId,
    );
    if (skipEnrichment || isRedisCacheOnly()) return sidecarHydrated;

    const before = firmConnectionsDisplayFingerprint(sidecarHydrated);
    const incompleteCount = [
      ...(sidecarHydrated.currentConnections || []),
      ...(sidecarHydrated.previousConnections || []),
    ].filter(connectionNeedsDisplayEnrichment).length;
    if (!incompleteCount) return sidecarHydrated;

    // Cap enrichment hard — mega-firm 800×2 Redis GETs can exhaust Upstash quickly.
    const enriched = await attachConnectionDisplayFields(sidecarHydrated, normalizedFirmId, redis, {
      displayIncompleteOnly: true,
      maxLookups: 40,
    });
    const after = firmConnectionsDisplayFingerprint(enriched);
    if (after !== before && redis && canWriteToRedis()) {
      try {
        await setStringIfValid(
          cacheKey,
          JSON.stringify(enriched),
          FIRM_CONNECTIONS_CACHE_TTL_SECONDS,
        );
      } catch {
        // read path still returns the enriched payload even if the write-back fails
      }
    }
    return enriched;
  }

  // Cache-only / Redis miss: serve local firm-connections disk file for display.
  if (local.payload && countFirmConnectionEntries(local.payload) > 0) {
    return hydrateFirmConnectionsFromSearchSidecar(local.payload, normalizedFirmId);
  }

  if (!options?.computeIfMissing) {
    return { currentConnections: [], previousConnections: [] };
  }

  let redisHit: FirmConnectionsPayload | null = null;
  if (redis) {
    try {
      redisHit = await readRedisFirmConnections();
    } catch {
      redisHit = null;
    }
  }

  const cachedOfficial = isOfficialFirmRoster(redisHit)
    ? redisHit
    : isOfficialFirmRoster(local.payload)
      ? local.payload
      : null;
  if (cachedOfficial && countFirmConnectionEntries(cachedOfficial) > 0) {
    return attachConnectionDisplayFields(cachedOfficial, normalizedFirmId, redis);
  }

  // Incomplete crawl/primed collections are not the roster. Refresh from the
  // official FINRA/SEC individual-by-firm search and store the result in the
  // firm-connections collection the UI already reads.
  const official = await fetchOfficialFirmRoster(normalizedFirmId).catch(
    () => null,
  );
  if (official && countFirmConnectionEntries(official) > 0) {
    // A connection can also exist purely because an individual's own detail record lists
    // this firm CRD as a current/previous employer, even if the official firm-roster search
    // (which can be incomplete/paginated/rate-limited) didn't surface that person. The mono
    // graph store's employed_by links were previously merged in here as a superset source but
    // have been removed — validation now comes exclusively from each individual's own cached
    // employment history via enrichConnectionEntriesFromIndividualCache elsewhere in this file.
    const extras = mergeGraphConnectionEntries([
      official.currentConnections || [],
      official.previousConnections || [],
      redisHit?.currentConnections || [],
      redisHit?.previousConnections || [],
      local.payload?.currentConnections || [],
      local.payload?.previousConnections || [],
    ]);
    const result: FirmConnectionsPayload = {
      ...extras,
      source: OFFICIAL_FIRM_ROSTER_SOURCE,
      officialTotals: official.officialTotals,
      fetchedAt: official.fetchedAt,
    };
    await persistFirmConnections(
      result,
      cacheKey,
      emptyCacheKey,
      local.path,
      normalizedFirmId,
    );
    return attachConnectionDisplayFields(result, normalizedFirmId, redis);
  }

  const combined = mergeGraphConnectionEntries([
    redisHit?.currentConnections || [],
    redisHit?.previousConnections || [],
    local.payload?.currentConnections || [],
    local.payload?.previousConnections || [],
  ]);

  if (countFirmConnectionEntries(combined) > 0) {
    return attachConnectionDisplayFields(combined, normalizedFirmId, redis);
  }

  if (redis) {
    try {
      const emptyHit = await redis.get(emptyCacheKey);
      if (emptyHit != null) {
        return { currentConnections: [], previousConnections: [] };
      }
    } catch {
      // fall through to compute
    }
  }

  const computed = await computeFirmConnectionsFromGraph(normalizedFirmId);
  await persistFirmConnections(
    computed,
    cacheKey,
    emptyCacheKey,
    local.path,
    normalizedFirmId,
  );
  return attachConnectionDisplayFields(computed, normalizedFirmId, redis);
}
