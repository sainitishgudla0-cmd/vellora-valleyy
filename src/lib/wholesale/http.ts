import { NextResponse } from "next/server";
import { OrderError } from "@/lib/orders";
import type { QuoteResult } from "./quotes";
import type { AccountResult } from "./accounts";

/** Maps service failures to HTTP: 404 not found, 403 not approved, 422 validation (with `fields`), 409 everything state-related (with `code`). */
export function failure(r: Extract<QuoteResult, { ok: false }> | Extract<AccountResult, { ok: false }>) {
  const code = r.code;
  if (code === "not_found") return NextResponse.json({ error: r.message }, { status: 404 });
  if (code === "account_not_approved") return NextResponse.json({ error: r.message, code }, { status: 403 });
  if (code === "validation" || code === "invalid_gstin" || code === "credit_limit_required") {
    const fields = "fields" in r ? r.fields : undefined;
    return NextResponse.json({ error: r.message, code, ...(fields ? { fields } : {}) }, { status: 422 });
  }
  return NextResponse.json({ error: r.message, code }, { status: 409 });
}

export const orderFailure = (e: unknown) => (e instanceof OrderError ? NextResponse.json({ error: e.message }, { status: e.status }) : null);
