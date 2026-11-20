/**
 * Production baselining rehearsal (M11 P2-T2, finding F02). DISPOSABLE SERVERS ONLY.
 *
 *   TEST_TARGET=disposable APP_ENV=test DATABASE_URL=postgresql://…@127.0.0.1:…/<db> npm run db:baseline-rehearsal
 *
 * Production was created by `prisma db push` from `main`'s schema (byte-identical to the schema `0_init` was generated
 * from, commit aaeb082) and has no `_prisma_migrations` table. This script replays RUNBOOK-DATABASE.md "Production
 * baselining" steps 3-5 against throwaway databases it creates next to the disposable one (`<db>_rehearsal_<n>`), and
 * drops them at the end:
 *
 *  A. main-shaped database with main-era rows (every order status / payment status / method `main` can write, items,
 *     enquiries, subscribers):
 *     1. schema built from `0_init` (= main's schema) — the shape `db push` produced
 *     2. read-only diff against the 0_init schema: empty                                   (runbook step 3)
 *     3. `migrate deploy` before baselining: refused with P3005, nothing changed            (step 4)
 *     4. `migrate resolve --applied 0_init`, then `migrate deploy`: every later migration   (steps 4-5)
 *     5. `migrate status` up to date, schema diff vs prisma/schema.prisma empty
 *     6. every main-era row is still there with the same values; the current Prisma client reads them (orders with items,
 *        products with variants, enquiries), legacy orders are `paymentMode` NULL (never guessed)
 *  B. the same with one order holding a status `main`'s schema allowed but the enum does not ("Pending"): the M2 enum
 *     migration must abort with its pre-check message, leave the order table untouched, and be recoverable with
 *     `migrate resolve --rolled-back` after the row is fixed.
 *
 * Exit 0 = every check passed. Prints counts and outcomes only (no URLs, no secrets).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDatabase, assertTestTargetDeclared } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();
assertTestTargetDeclared();
assertDisposableDatabase(process.env, "baseline rehearsal");

const root = path.resolve(__dirname, "..");
const base = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!);
const tag = `${process.pid}${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, "");
const LATER_MIGRATIONS = fs.readdirSync(path.join(root, "prisma/migrations")).filter((d) => /^\d{14}_/.test(d)).sort();

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const urlFor = (db: string) => {
  const u = new URL(base.toString());
  u.pathname = `/${db}`;
  return u.toString();
};

function prisma(args: string[], url: string, input?: string) {
  const r = spawnSync("npx", ["prisma", ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url }, encoding: "utf8", input });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Every write goes through `prisma db execute` against a scratch database this script created (never the app client). */
function sql(url: string, statement: string) {
  const r = prisma(["db", "execute", "--stdin", "--url", url], url, statement);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.out.slice(-300)}`);
}

/** main's Order statuses x payment states, as main's checkout/admin could write them (strings; the enum came in M2). */
const MAIN_ORDERS: { status: string; paymentMethod: string; paymentStatus: string }[] = [
  { status: "pending_confirmation", paymentMethod: "cod", paymentStatus: "unpaid" },
  { status: "confirmed", paymentMethod: "cod", paymentStatus: "unpaid" },
  { status: "dispatched", paymentMethod: "cod", paymentStatus: "unpaid" },
  { status: "delivered", paymentMethod: "cod", paymentStatus: "paid" },
  { status: "cancelled", paymentMethod: "cod", paymentStatus: "unpaid" },
  { status: "awaiting_payment", paymentMethod: "razorpay", paymentStatus: "unpaid" },
  { status: "paid", paymentMethod: "razorpay", paymentStatus: "paid" },
  { status: "awaiting_payment", paymentMethod: "razorpay", paymentStatus: "failed" },
  { status: "cancelled", paymentMethod: "razorpay", paymentStatus: "refunded" },
];

function loadMainEraData(url: string, extraStatus?: string) {
  const now = "2026-10-01 10:00:00";
  const rows = extraStatus ? [...MAIN_ORDERS, { status: extraStatus, paymentMethod: "cod", paymentStatus: "unpaid" }] : MAIN_ORDERS;
  const stmts = [
    `INSERT INTO "Product" ("id","slug","name","tagline","description","primaryCategory","categories","images","updatedAt") VALUES ('p_reh','rehearsal-cashews','Rehearsal Cashews','t','d','nuts','["nuts"]','[]','${now}');`,
    `INSERT INTO "Variant" ("id","sku","label","weightGrams","price","mrp","shelfLife","hsCode","productId") VALUES ('v_reh','REH-250','250 g',250,45000,50000,'6 months','0801','p_reh');`,
    ...rows.flatMap((o, i) => [
      `INSERT INTO "Order" ("id","number","accessToken","status","paymentMethod","paymentStatus","customerName","email","phone","addressLine1","city","state","pincode","subtotal","deliveryFee","total","razorpayOrderId","updatedAt") VALUES ('o_reh${i}','VV-REH-${i}','tok${i}','${o.status}','${o.paymentMethod}','${o.paymentStatus}','Rehearsal ${i}','rehearsal${i}@example.test','9876543210','1 Street','City','Karnataka','560001',45000,5000,50000,${o.paymentMethod === "razorpay" ? `'order_reh${i}'` : "NULL"},'${now}');`,
      `INSERT INTO "OrderItem" ("id","orderId","variantId","productName","variantLabel","sku","unitPrice","quantity","lineTotal") VALUES ('oi_reh${i}','o_reh${i}','v_reh','Rehearsal Cashews','250 g','REH-250',45000,1,45000);`,
    ]),
    `INSERT INTO "Enquiry" ("id","type","name","email","message","status") VALUES ('e_reh','business','R','r@example.test','hello there friend','new');`,
    `INSERT INTO "Subscriber" ("id","email") VALUES ('s_reh','s@example.test');`,
  ];
  sql(url, stmts.join("\n"));
  return rows.length;
}

const snapshot = (c: PrismaClient) =>
  c.$queryRawUnsafe<{ id: string; status: string; paymentMethod: string; paymentStatus: string; total: number; number: string }[]>(
    `SELECT "id","status"::text AS "status","paymentMethod"::text AS "paymentMethod","paymentStatus"::text AS "paymentStatus","total","number" FROM "Order" ORDER BY "id"`,
  );

async function withScratch(name: string, fn: (url: string, c: PrismaClient) => Promise<void>) {
  const db = `${base.pathname.slice(1)}_rehearsal_${name}_${tag}`.slice(0, 63);
  sql(base.toString(), `CREATE DATABASE "${db}";`);
  const url = urlFor(db);
  const c = new PrismaClient({ datasources: { db: { url } } });
  try {
    await fn(url, c);
  } finally {
    await c.$disconnect();
    sql(base.toString(), `DROP DATABASE IF EXISTS "${db}" WITH (FORCE);`);
  }
}

function buildMainShape(url: string) {
  const r = prisma(["db", "execute", "--file", "prisma/migrations/0_init/migration.sql", "--url", url], url);
  check("main-shaped schema created from 0_init (= main's schema.prisma)", r.status === 0, r.out.slice(-300));
}

/** The 0_init schema as a datamodel file: from git when available (commit aaeb082 is main's schema), else skipped. */
function initSchemaFile(): string | null {
  const g = spawnSync("git", ["show", "aaeb082:prisma/schema.prisma"], { cwd: root, encoding: "utf8" });
  if (g.status !== 0) return null;
  const f = path.join(os.tmpdir(), `schema-0_init-${tag}.prisma`);
  fs.writeFileSync(f, g.stdout);
  return f;
}

async function rehearsalA() {
  console.log("\nA. main-shaped database with main-era rows");
  await withScratch("a", async (url, c) => {
    buildMainShape(url);
    const n = loadMainEraData(url);
    const before = await snapshot(c);
    check(`${n} main-era orders loaded (every status/payment combination main writes)`, before.length === n);

    const initSchema = initSchemaFile();
    if (initSchema) {
      const d = prisma(["migrate", "diff", "--from-url", url, "--to-schema-datamodel", initSchema, "--script", "--exit-code"], url);
      check("runbook step 3: diff against the 0_init schema is empty (exit 0)", d.status === 0 && /empty migration/i.test(d.out), d.out.slice(-300));
      fs.rmSync(initSchema, { force: true });
    } else {
      console.log("  - runbook step 3 diff skipped (git history for aaeb082 not available here)");
    }

    const p3005 = prisma(["migrate", "deploy"], url);
    check("migrate deploy before baselining is refused with P3005", p3005.status !== 0 && p3005.out.includes("P3005"), p3005.out.slice(-300));
    check("…and changed nothing", JSON.stringify(await snapshot(c)) === JSON.stringify(before));

    const resolve = prisma(["migrate", "resolve", "--applied", "0_init"], url);
    check("migrate resolve --applied 0_init", resolve.status === 0, resolve.out.slice(-300));
    const deploy = prisma(["migrate", "deploy"], url);
    const applied = LATER_MIGRATIONS.filter((m) => deploy.out.includes(m)).length;
    check(`migrate deploy applies all ${LATER_MIGRATIONS.length} later migrations`, deploy.status === 0 && applied === LATER_MIGRATIONS.length, { status: deploy.status, applied, tail: deploy.out.slice(-400) });
    const status = prisma(["migrate", "status"], url);
    check("migrate status: up to date", status.status === 0 && /up to date/i.test(status.out), status.out.slice(-300));
    const diff = prisma(["migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], url);
    check("schema diff against prisma/schema.prisma: no difference", diff.status === 0, diff.out.slice(-300));

    const after = await snapshot(c);
    check("every main-era order kept its id, number, total and statuses", JSON.stringify(after) === JSON.stringify(before), { before: before.length, after: after.length });
    const legacy = await c.order.findMany({ include: { items: true, payments: true } });
    check("current Prisma client reads every migrated order with its items", legacy.length === n && legacy.every((o) => o.items.length === 1));
    check("legacy orders are unclassified (paymentMode NULL), never guessed", legacy.every((o) => o.paymentMode === null));
    const product = await c.product.findUnique({ where: { slug: "rehearsal-cashews" }, include: { variants: true } });
    check("products and variants readable; stock tracking off by default (manual inStock kept)", product?.variants[0]?.trackInventory === false && product.variants[0].inStock === true);
    check("enquiries and subscribers kept", (await c.enquiry.count()) === 1 && (await c.subscriber.count()) === 1);
  });
}

async function rehearsalB() {
  console.log("\nB. a main-era value the enum does not accept stops the release safely");
  await withScratch("b", async (url, c) => {
    buildMainShape(url);
    loadMainEraData(url, "Pending");
    const before = await snapshot(c);
    check("resolve --applied 0_init", prisma(["migrate", "resolve", "--applied", "0_init"], url).status === 0);
    const deploy = prisma(["migrate", "deploy"], url);
    check("migrate deploy fails on the M2 enum pre-check, naming the offending value", deploy.status !== 0 && deploy.out.includes("unsupported legacy values") && deploy.out.includes("Pending"), deploy.out.slice(-400));
    check("the Order table is untouched (still text, same rows)", JSON.stringify(await snapshot(c)) === JSON.stringify(before));
    // recovery as the runbook describes: fix the row (a human decision), mark the failed migration rolled back, redeploy
    sql(url, `UPDATE "Order" SET "status" = 'pending_confirmation' WHERE "status" = 'Pending';`);
    const rolled = prisma(["migrate", "resolve", "--rolled-back", LATER_MIGRATIONS[0]], url);
    check(`migrate resolve --rolled-back ${LATER_MIGRATIONS[0]}`, rolled.status === 0, rolled.out.slice(-300));
    const again = prisma(["migrate", "deploy"], url);
    check("redeploy after the fix applies every migration", again.status === 0, again.out.slice(-300));
    check("schema diff: no difference", prisma(["migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], url).status === 0);
  });
}

async function main() {
  console.log(`[baseline-rehearsal] ${LATER_MIGRATIONS.length} migrations after 0_init`);
  await rehearsalA();
  await rehearsalB();
  console.log(failures ? `\n[baseline-rehearsal] ✗ ${failures} check(s) failed` : "\n[baseline-rehearsal] ✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`[baseline-rehearsal] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
