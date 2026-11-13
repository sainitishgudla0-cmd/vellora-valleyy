import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log, errorName } from "@/lib/log";

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3000;

/**
 * Uptime probe (M9-T5). `200 { ok: true }` when the app can reach its database, `503 { ok: false }` otherwise.
 * Public by design and deliberately minimal: no versions, hosts, counts or error text. Never cached.
 */
export async function GET() {
  let ok = false;
  try {
    await Promise.race([db.$queryRaw`SELECT 1`, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS))]);
    ok = true;
  } catch (e) {
    log.error("health.database_unreachable", { errorName: errorName(e) });
  }
  return NextResponse.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
