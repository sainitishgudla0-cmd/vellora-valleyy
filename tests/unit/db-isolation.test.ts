import { describe, expect, it } from "vitest";
import { checkDatabaseIsolation } from "@/lib/env/isolation";

const PROD = "ep-prod-123.ap-southeast-1.aws.neon.tech";
const PREVIEW = "ep-preview-456.ap-southeast-1.aws.neon.tech";
const url = (host: string) => `postgresql://u:p@${host}/db`;

describe("database isolation (M9-T2)", () => {
  it("refuses a preview that points at the production database (direct or pooled host)", () => {
    for (const host of [PROD, PROD.replace("ep-prod-123", "ep-prod-123-pooler")]) {
      const r = checkDatabaseIsolation({ VERCEL_ENV: "preview", DATABASE_URL: url(host), PRODUCTION_DB_HOSTS: PROD });
      expect(r.ok).toBe(false);
      expect(r.issues.join(" ")).toMatch(/production database host/);
    }
  });

  it("also checks the unpooled URL", () => {
    const r = checkDatabaseIsolation({ VERCEL_ENV: "preview", DATABASE_URL: url(PREVIEW), DATABASE_URL_UNPOOLED: url(PROD), PRODUCTION_DB_HOSTS: PROD });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/DATABASE_URL_UNPOOLED/);
  });

  it("accepts a preview with its own database", () => {
    expect(checkDatabaseIsolation({ VERCEL_ENV: "preview", DATABASE_URL: url(PREVIEW), DATABASE_URL_UNPOOLED: url(PREVIEW), PRODUCTION_DB_HOSTS: PROD }).ok).toBe(true);
  });

  it("fails closed: a preview with a database but no PRODUCTION_DB_HOSTS cannot prove isolation", () => {
    const r = checkDatabaseIsolation({ VERCEL_ENV: "preview", DATABASE_URL: url(PREVIEW) });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/PRODUCTION_DB_HOSTS/);
  });

  it("refuses an unparseable preview database URL", () => {
    expect(checkDatabaseIsolation({ VERCEL_ENV: "preview", DATABASE_URL: "not a url", PRODUCTION_DB_HOSTS: PROD }).ok).toBe(false);
  });

  it("a preview with no database at all builds (previews may be disabled or static)", () => {
    expect(checkDatabaseIsolation({ VERCEL_ENV: "preview" }).ok).toBe(true);
  });

  it("production must use a listed host; a swapped variable is refused", () => {
    expect(checkDatabaseIsolation({ VERCEL_ENV: "production", DATABASE_URL: url(PROD), PRODUCTION_DB_HOSTS: PROD }).ok).toBe(true);
    const r = checkDatabaseIsolation({ VERCEL_ENV: "production", DATABASE_URL: url(PREVIEW), PRODUCTION_DB_HOSTS: PROD });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/does not point at a host listed/);
  });

  it("production without PRODUCTION_DB_HOSTS builds but warns", () => {
    const r = checkDatabaseIsolation({ VERCEL_ENV: "production", DATABASE_URL: url(PROD) });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/PRODUCTION_DB_HOSTS/);
  });

  it("does nothing in development and test (those have their own guards)", () => {
    expect(checkDatabaseIsolation({ APP_ENV: "test", DATABASE_URL: "postgresql://u@127.0.0.1/x" })).toEqual({ ok: true, issues: [], warnings: [] });
    expect(checkDatabaseIsolation({ DATABASE_URL: url(PROD), PRODUCTION_DB_HOSTS: PROD })).toEqual({ ok: true, issues: [], warnings: [] });
  });
});
