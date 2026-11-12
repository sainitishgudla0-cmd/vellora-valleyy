import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/test-environment/route";

const LOCAL_DB = "postgresql://u:p@127.0.0.1:5432/velora_test";

const call = async () => {
  const res = await GET();
  return { status: res.status, body: await res.json() };
};

describe("GET /api/internal/test-environment", () => {
  beforeEach(() => {
    for (const k of ["VERCEL_ENV", "APP_ENV", "TEST_TARGET", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "DISPOSABLE_DB_HOSTS", "PRODUCTION_DB_HOSTS"]) vi.stubEnv(k, "");
  });

  it("is 404 on production and preview deployments", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("TEST_TARGET", "disposable");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    expect((await call()).status).toBe(404);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await call()).status).toBe(404);
  });

  it("is 404 for an unlabelled production build (NODE_ENV=production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await call()).status).toBe(404);
  });

  it("is 404 when the environment is contradictory", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_ENV", "test");
    expect((await call()).status).toBe(404);
  });

  it("allows writes only with TEST_TARGET=disposable and a disposable database", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("TEST_TARGET", "disposable");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    expect(await call()).toEqual({ status: 200, body: { appEnv: "test", testWritesAllowed: true, reasons: [] } });
  });

  it("reports refusal when the database is remote and not allow-listed", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("TEST_TARGET", "disposable");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-prod.neon.tech/neondb");
    const r = await call();
    expect(r.body.testWritesAllowed).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("u:p");
  });

  it("reports refusal without TEST_TARGET", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    expect((await call()).body.testWritesAllowed).toBe(false);
  });
});
