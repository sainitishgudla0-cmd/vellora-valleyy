import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvSafetyError } from "@/lib/env/app-env";
import {
  assertDatabaseWriteAllowed,
  assertDisposableDatabase,
  assertSafeTestUrl,
  assertTestTargetDeclared,
  describeDatabaseUrl,
} from "@/lib/env/test-safety";
import { assertServerIsDisposable } from "../../scripts/lib/safety";

const LOCAL_DB = "postgresql://u:secret@localhost:5432/velora_test";
const NEON_DB = "postgresql://u:secret@ep-cool-name-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const NEON_DIRECT = "postgresql://u:secret@ep-cool-name.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("assertTestTargetDeclared", () => {
  it("requires TEST_TARGET=disposable", () => {
    expect(() => assertTestTargetDeclared({})).toThrow(EnvSafetyError);
    expect(() => assertTestTargetDeclared({ TEST_TARGET: "prod" })).toThrow(EnvSafetyError);
    expect(() => assertTestTargetDeclared({ TEST_TARGET: "disposable" })).not.toThrow();
  });
});

describe("assertSafeTestUrl", () => {
  const env = { TEST_TARGET: "disposable" };
  it("allows loopback", () => {
    expect(assertSafeTestUrl("http://localhost:3000", env).host).toBe("localhost:3000");
    expect(assertSafeTestUrl("http://127.0.0.1:3100", env).hostname).toBe("127.0.0.1");
  });
  it("always rejects known production hosts, even if allow-listed", () => {
    for (const u of ["https://velora-valley.vercel.app", "https://veloravalley.com", "https://WWW.veloravalley.com/shop"]) {
      expect(() => assertSafeTestUrl(u, { ...env, TEST_ALLOWED_HOSTS: "velora-valley.vercel.app,veloravalley.com,www.veloravalley.com" })).toThrow(/production host/);
    }
  });
  it("rejects extra hosts declared in PRODUCTION_HOSTS", () => {
    expect(() => assertSafeTestUrl("https://shop.example.in", { ...env, PRODUCTION_HOSTS: "shop.example.in", TEST_ALLOWED_HOSTS: "shop.example.in" })).toThrow(/production host/);
  });
  it("rejects other remote hosts unless explicitly allow-listed", () => {
    expect(() => assertSafeTestUrl("https://velora-valley-git-x.vercel.app", env)).toThrow(/not loopback/);
    expect(assertSafeTestUrl("https://qa.internal.test", { ...env, TEST_ALLOWED_HOSTS: "qa.internal.test" }).hostname).toBe("qa.internal.test");
  });
  it("fails closed without TEST_TARGET or with an invalid URL", () => {
    expect(() => assertSafeTestUrl("http://localhost:3000", {})).toThrow(/TEST_TARGET/);
    expect(() => assertSafeTestUrl("not a url", env)).toThrow(/not a valid URL/);
    expect(() => assertSafeTestUrl("ftp://localhost", env)).toThrow(/http/);
  });
});

describe("describeDatabaseUrl", () => {
  it("returns host and database but never credentials", () => {
    const d = describeDatabaseUrl(LOCAL_DB);
    expect(d).toEqual({ host: "localhost", database: "velora_test" });
    expect(JSON.stringify(d)).not.toContain("secret");
  });
  it("returns null for missing or non-postgres URLs", () => {
    expect(describeDatabaseUrl(undefined)).toBeNull();
    expect(describeDatabaseUrl("")).toBeNull();
    expect(describeDatabaseUrl("file:./dev.db")).toBeNull();
    expect(describeDatabaseUrl("garbage")).toBeNull();
  });
});

describe("assertDisposableDatabase", () => {
  it("accepts a loopback database in development/test", () => {
    expect(assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: LOCAL_DB }).host).toBe("localhost");
    expect(assertDisposableDatabase({ NODE_ENV: "development", DATABASE_URL: LOCAL_DB, DATABASE_URL_UNPOOLED: LOCAL_DB }).database).toBe("velora_test");
  });
  it("fails closed when the database identity cannot be established", () => {
    expect(() => assertDisposableDatabase({ APP_ENV: "test" })).toThrow(/cannot establish/);
    expect(() => assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: "nonsense" })).toThrow(/cannot establish/);
  });
  it("refuses remote databases that are not explicitly disposable", () => {
    expect(() => assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: NEON_DB })).toThrow(/DISPOSABLE_DB_HOSTS/);
    expect(() => assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: LOCAL_DB, DATABASE_URL_UNPOOLED: NEON_DIRECT })).toThrow(/DATABASE_URL_UNPOOLED/);
  });
  it("accepts an allow-listed disposable remote branch, but never a declared production host", () => {
    const host = "ep-cool-name-pooler.ap-southeast-1.aws.neon.tech";
    expect(assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: NEON_DB, DISPOSABLE_DB_HOSTS: host }).host).toBe(host);
    expect(() => assertDisposableDatabase({ APP_ENV: "test", DATABASE_URL: NEON_DB, DISPOSABLE_DB_HOSTS: host, PRODUCTION_DB_HOSTS: host })).toThrow(/production database host/);
  });
  it("refuses outside development/test", () => {
    expect(() => assertDisposableDatabase({ VERCEL_ENV: "preview", DATABASE_URL: LOCAL_DB })).toThrow(/preview/);
    expect(() => assertDisposableDatabase({ NODE_ENV: "production", DATABASE_URL: LOCAL_DB })).toThrow(/production/);
  });
});

describe("assertDatabaseWriteAllowed", () => {
  it("behaves like assertDisposableDatabase without a production confirmation", () => {
    expect(assertDatabaseWriteAllowed({ APP_ENV: "development", DATABASE_URL: LOCAL_DB })).toMatchObject({ host: "localhost", production: false });
    expect(() => assertDatabaseWriteAllowed({ APP_ENV: "development", DATABASE_URL: NEON_DB })).toThrow(EnvSafetyError);
  });
  it("allows production only with APP_ENV=production and a matching host confirmation", () => {
    const env = { APP_ENV: "production", DATABASE_URL: NEON_DB, DATABASE_URL_UNPOOLED: NEON_DIRECT };
    expect(assertDatabaseWriteAllowed({ ...env, CONFIRM_PRODUCTION_DB_HOST: "ep-cool-name.ap-southeast-1.aws.neon.tech" }).production).toBe(true);
    expect(() => assertDatabaseWriteAllowed({ ...env, CONFIRM_PRODUCTION_DB_HOST: "other.neon.tech" })).toThrow(/does not match/);
    expect(() => assertDatabaseWriteAllowed({ ...env, APP_ENV: "development", CONFIRM_PRODUCTION_DB_HOST: "ep-cool-name.ap-southeast-1.aws.neon.tech" })).toThrow(/not production/);
  });
});

describe("assertServerIsDisposable (HTTP handshake)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { TEST_TARGET: "disposable" };
  const stubFetch = (status: number, body?: unknown) => {
    const f = vi.fn(async () => new Response(body === undefined ? "" : JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("passes only when the server confirms testWritesAllowed=true", async () => {
    const f = stubFetch(200, { appEnv: "test", testWritesAllowed: true, reasons: [] });
    await expect(assertServerIsDisposable("http://localhost:3100", env)).resolves.toBeInstanceOf(URL);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("http://localhost:3100/api/internal/test-environment");
  });
  it("aborts when the server reports its database is not disposable", async () => {
    stubFetch(200, { testWritesAllowed: false, reasons: ["not disposable"] });
    await expect(assertServerIsDisposable("http://localhost:3100", env)).rejects.toThrow(/refused/);
  });
  it("aborts when the handshake endpoint is missing (e.g. production or an older deployment)", async () => {
    stubFetch(404, { error: "Not found" });
    await expect(assertServerIsDisposable("http://localhost:3100", env)).rejects.toThrow(/Cannot confirm/);
  });
  it("aborts when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(assertServerIsDisposable("http://localhost:3100", env)).rejects.toThrow(/ECONNREFUSED/);
  });
  it("never contacts a production host", async () => {
    const f = stubFetch(200, { testWritesAllowed: true });
    await expect(assertServerIsDisposable("https://velora-valley.vercel.app", env)).rejects.toThrow(/production host/);
    expect(f).not.toHaveBeenCalled();
  });
});
