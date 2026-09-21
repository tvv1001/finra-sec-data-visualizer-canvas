import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getRedisClient } from "@/lib/redisCache";

async function auditLogEntry(req: NextRequest, entry: Record<string, any>) {
  try {
    // Push to Redis admin audit list (best-effort)
    const redis = getRedisClient();
    if (redis) {
      await redis
        .lpush("dashboard:admin-audit", JSON.stringify(entry))
        .catch(() => null);
      await redis.ltrim("dashboard:admin-audit", 0, 999).catch(() => null);
    }
    // Also append to local disk logfile for permanent audit trail
    try {
      const logDir = path.join(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const out = path.join(logDir, "admin-audit.log");
      const line =
        JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(out, line, "utf8");
    } catch {}
  } catch {}
}

function allowedSecretMatches(req: NextRequest) {
  const expected =
    process.env.ADMIN_PUSH_SECRET || process.env.PUSH_SECRET || "";
  if (!expected) return false;
  const header =
    req.headers.get("x-admin-secret") || req.headers.get("authorization") || "";
  if (!header) return false;
  if (header.startsWith("Bearer ")) return header.slice(7) === expected;
  return header === expected;
}

export async function POST(req: NextRequest) {
  try {
    if (!allowedSecretMatches(req)) {
      await auditLogEntry(req, {
        action: "push-firm-connections-attempt",
        ok: false,
        reason: "unauthorized",
        ua: req.headers.get("user-agent") || "",
        ip:
          req.headers.get("x-forwarded-for") ||
          req.headers.get("x-real-ip") ||
          "local",
      }).catch(() => null);
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }

    await auditLogEntry(req, {
      action: "push-firm-connections-attempt",
      ok: false,
      reason: "read-only-firm-connections-cache",
      ua: req.headers.get("user-agent") || "",
      ip:
        req.headers.get("x-forwarded-for") ||
        req.headers.get("x-real-ip") ||
        "local",
    }).catch(() => null);

    return NextResponse.json(
      {
        ok: false,
        error: "firm-connections:firm:* is read-only; no writes are allowed from app code or admin pushes.",
      },
      { status: 403 },
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  // Allow quick GET health check when authenticated with ?firmId=123
  try {
    if (!allowedSecretMatches(req))
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    const url = new URL(req.url);
    const firmId = url.searchParams.get("firmId") || undefined;
    if (!firmId)
      return NextResponse.json(
        { ok: false, error: "missing firmId query" },
        { status: 400 },
      );
    // proxy to POST behavior for single firm
    return await POST(
      new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ firmId }),
      }) as unknown as NextRequest,
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}
