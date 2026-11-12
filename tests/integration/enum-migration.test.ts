/**
 * M2-T1 migration rehearsal. Builds scratch databases on the *disposable* server (guarded by global-setup),
 * applies 0_init, inserts representative legacy string rows, then applies the enum migration.
 * Nothing here touches the database named in DATABASE_URL except to CREATE/DROP the scratch databases.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDatabase } from "@/lib/env/test-safety";

const target = assertDisposableDatabase(process.env, "enum migration rehearsal");
const migrationsDir = path.join(process.cwd(), "prisma/migrations");
const ENUM_DIR = fs.readdirSync(migrationsDir).find((d) => d.endsWith("_order_payment_enums"))!;
// These tests build scratch databases and replay every migration; that grows with each milestone and was timing out at 5 s on CI (M3).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

const admin = new PrismaClient();
const scratch: string[] = [];
const clients: PrismaClient[] = [];

function urlFor(dbName: string) {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function newScratch(tag: string) {
  const name = `velora_rehearsal_${tag}_${process.pid}_${Date.now()}`;
  expect(name).toMatch(/^velora_rehearsal_[a-z_0-9]+$/); // safe to interpolate
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  scratch.push(name);
  const url = urlFor(name);
  // Defence in depth: the scratch URL must itself be provably disposable before any write.
  assertDisposableDatabase({ ...process.env, DATABASE_URL: url }, "scratch database");
  const client = new PrismaClient({ datasourceUrl: url });
  clients.push(client);
  return { name, url, client };
}

function runSql(url: string, migration: string) {
  const file = path.join(migrationsDir, migration, "migration.sql");
  try {
    execFileSync(process.execPath, [prismaCli, "db", "execute", "--url", url, "--file", file], { stdio: "pipe", encoding: "utf8" });
    return { ok: true as const, output: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false as const, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

let seq = 0;
const insertLegacy = (c: PrismaClient, status: string, paymentMethod: string, paymentStatus?: string) => {
  const n = `LEGACY-${seq++}`;
  return c.$executeRawUnsafe(
    `INSERT INTO "Order" ("id","number","accessToken","status","paymentMethod"${paymentStatus ? ',"paymentStatus"' : ""},"customerName","email","phone","addressLine1","city","state","pincode","subtotal","deliveryFee","total","updatedAt")
     VALUES ($1,$2,'tok',$3,$4${paymentStatus ? ",$5" : ""},'SMOKE TEST Legacy','smoke.legacy@example.com','9876543210','1 Test Street','Anantapur','Andhra Pradesh','515001',1000,50,1050,now())`,
    ...[`id-${n}`, n, status, paymentMethod, ...(paymentStatus ? [paymentStatus] : [])],
  );
};

const columnTypes = (c: PrismaClient) =>
  c.$queryRaw<{ column_name: string; udt_name: string; column_default: string | null }[]>`
    SELECT column_name, udt_name, column_default FROM information_schema.columns
    WHERE table_name = 'Order' AND column_name IN ('status','paymentMethod','paymentStatus') ORDER BY column_name`;

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
  for (const name of scratch) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.$disconnect();
});

describe("order/payment enum migration on representative legacy data", () => {
  it("runs against a disposable server only", () => {
    expect(["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.host) || process.env.TEST_TARGET === "disposable").toBe(true);
  });

  it("preserves every legacy row and value, converts types and keeps the unpaid default", async () => {
    const { url, client } = await newScratch("ok");
    expect(runSql(url, "0_init").ok).toBe(true);

    const legacy: [string, string, string | undefined][] = [
      ["pending_confirmation", "cod", "unpaid"], // request-only order: must stay unpaid
      ["pending_confirmation", "cod", undefined], // relies on the old column default
      ["awaiting_payment", "razorpay", "unpaid"],
      ["awaiting_payment", "razorpay", "failed"],
      ["confirmed", "cod", "unpaid"],
      ["paid", "razorpay", "paid"],
      ["dispatched", "razorpay", "paid"],
      ["delivered", "cod", "paid"], // manually reconciled cash on delivery
      ["cancelled", "razorpay", "failed"],
      ["cancelled", "cod", "refunded"],
    ];
    for (const [s, m, p] of legacy) await insertLegacy(client, s, m, p);
    const before = await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT "id","status","paymentMethod","paymentStatus","createdAt","updatedAt","total" FROM "Order" ORDER BY "id"`);
    expect(before).toHaveLength(legacy.length);

    const r = runSql(url, ENUM_DIR);
    expect(r.ok, r.output).toBe(true);

    const after = await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT "id","status"::text AS "status","paymentMethod"::text AS "paymentMethod","paymentStatus"::text AS "paymentStatus","createdAt","updatedAt","total" FROM "Order" ORDER BY "id"`);
    expect(after).toEqual(before); // byte-for-byte equal values, timestamps and amounts untouched

    expect(await columnTypes(client)).toEqual([
      { column_name: "paymentMethod", udt_name: "PaymentMethod", column_default: null },
      { column_name: "paymentStatus", udt_name: "PaymentStatus", column_default: "'unpaid'::\"PaymentStatus\"" },
      { column_name: "status", udt_name: "OrderStatus", column_default: null },
    ]);

    // Default still applies for new rows, and the database now rejects invalid values.
    await client.$executeRawUnsafe(
      `INSERT INTO "Order" ("id","number","accessToken","status","paymentMethod","customerName","email","phone","addressLine1","city","state","pincode","subtotal","deliveryFee","total","updatedAt")
       VALUES ('id-default','LEGACY-DEFAULT','tok','pending_confirmation','cod','SMOKE TEST','smoke.d@example.com','9876543210','1 St','Anantapur','Andhra Pradesh','515001',1,1,2,now())`,
    );
    const [d] = await client.$queryRawUnsafe<{ paymentStatus: string }[]>(`SELECT "paymentStatus"::text AS "paymentStatus" FROM "Order" WHERE "id"='id-default'`);
    expect(d.paymentStatus).toBe("unpaid");
    await expect(insertLegacy(client, "shipped", "cod", "unpaid")).rejects.toThrow();
    await expect(insertLegacy(client, "paid", "bank_transfer", "paid")).rejects.toThrow();

    // Prisma Client reads/writes the converted table with unchanged JSON values.
    const rows = await client.order.findMany({ where: { paymentStatus: "unpaid", status: "pending_confirmation" }, orderBy: { number: "asc" }, select: { status: true, paymentMethod: true, paymentStatus: true } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(JSON.stringify(rows[0]))).toMatchObject({ status: "pending_confirmation", paymentMethod: "cod", paymentStatus: "unpaid" });
  });

  it("migrates an empty Order table", async () => {
    const { url, client } = await newScratch("empty");
    expect(runSql(url, "0_init").ok).toBe(true);
    expect(runSql(url, ENUM_DIR).ok).toBe(true);
    expect(await client.order.count()).toBe(0);
  });

  it.each([
    ["status", "shipped", ["status", "'shipped'"]],
    ["status", "Paid", ["status", "'Paid'"]], // case variants are not silently normalised
    ["status", " paid", ["status", "' paid'"]], // whitespace is not silently trimmed
    ["paymentStatus", "settled", ["paymentStatus", "'settled'"]],
    ["paymentMethod", "upi", ["paymentMethod", "'upi'"]],
  ] as const)("aborts with a clear message and changes nothing when %s holds unknown value %j", async (column, bad, expected) => {
    const { url, client } = await newScratch("bad");
    expect(runSql(url, "0_init").ok).toBe(true);
    await insertLegacy(client, "pending_confirmation", "cod", "unpaid");
    await insertLegacy(client, "paid", "razorpay", "paid");
    const vals = { status: "confirmed", paymentMethod: "cod", paymentStatus: "unpaid", [column]: bad } as Record<string, string>;
    await insertLegacy(client, vals.status, vals.paymentMethod, vals.paymentStatus);
    const before = await client.$queryRawUnsafe<unknown[]>(`SELECT * FROM "Order" ORDER BY "id"`);

    const r = runSql(url, ENUM_DIR);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("M2-T1 enum migration aborted");
    for (const frag of expected) expect(r.output).toContain(frag);

    // Atomic: no enum types created, columns still TEXT, every row byte-identical.
    const types = await client.$queryRaw<{ typname: string }[]>`SELECT typname FROM pg_type WHERE typname IN ('OrderStatus','PaymentStatus','PaymentMethod')`;
    expect(types).toEqual([]);
    expect((await columnTypes(client)).map((c) => c.udt_name)).toEqual(["text", "text", "text"]);
    expect(await client.$queryRawUnsafe(`SELECT * FROM "Order" ORDER BY "id"`)).toEqual(before);
  });

  it("reports every offending value in a single failure", async () => {
    const { url, client } = await newScratch("multi");
    expect(runSql(url, "0_init").ok).toBe(true);
    await insertLegacy(client, "shipped", "cod", "unpaid");
    await insertLegacy(client, "shipped", "cod", "unpaid");
    await insertLegacy(client, "paid", "wallet", "oops");
    const r = runSql(url, ENUM_DIR);
    expect(r.ok).toBe(false);
    for (const frag of ["status='shipped' (2 rows)", "paymentStatus='oops' (1 rows)", "paymentMethod='wallet' (1 rows)"]) expect(r.output).toContain(frag);
  });

  it("the migrated schema equals schema.prisma (no drift)", async () => {
    const { url } = await newScratch("drift");
    expect(runSql(url, "0_init").ok).toBe(true);
    expect(runSql(url, ENUM_DIR).ok).toBe(true);
    // later migrations (applied after the enum migration, in order) complete the schema
    const later = fs.readdirSync(migrationsDir).filter((d) => /^\d/.test(d) && d > ENUM_DIR).sort();
    for (const m of later) expect(runSql(url, m).ok, m).toBe(true);
    // exit code 0 = no difference
    execFileSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { stdio: "pipe" });
  });
});
