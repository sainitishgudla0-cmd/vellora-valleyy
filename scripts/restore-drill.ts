/**
 * Backup and restore drill (M9-T7, ADR 0017, docs/RUNBOOK-DATABASE.md "Backup and restore drill").
 *
 *   TEST_TARGET=disposable APP_ENV=test DATABASE_URL=postgresql://…127.0.0.1…/velora_test npm run db:restore-drill
 *
 * Takes a logical backup (pg_dump -Fc) of the DISPOSABLE source database, restores it into a brand-new database on
 * the same server, and proves the copy is complete: per-table row counts and content checksums match, every Prisma
 * migration is recorded, `prisma migrate status` is clean and the schema has no drift. Prints the timings that feed
 * the RTO estimate. It refuses any source that is not provably disposable (src/lib/env/test-safety.ts) and only ever
 * drops the scratch database it created itself (name must start with "velora_restore_drill").
 *
 * It never connects to production. The production drill is an operator task (Neon branch / point-in-time restore),
 * described in the runbook; this script is the rehearsal and the verification checklist for it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDisposableDatabase } from "../src/lib/env/test-safety";
import { loadLocalEnv } from "./lib/safety";

loadLocalEnv();

const SCRATCH_PREFIX = "velora_restore_drill";
const PG_BIN = process.env.PG_BIN?.trim() || (fs.existsSync("/opt/homebrew/opt/postgresql@16/bin/pg_dump") ? "/opt/homebrew/opt/postgresql@16/bin" : "");
const bin = (name: string) => (PG_BIN ? path.join(PG_BIN, name) : name);

type Conn = { host: string; port: string; user: string; password: string; database: string };

function parse(raw: string): Conn {
  const u = new URL(raw);
  return { host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) };
}
const urlFor = (c: Conn, database: string) => `postgresql://${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ""}@${c.host}:${c.port}/${database}`;
const pgEnv = (c: Conn) => ({ ...process.env, PGPASSWORD: c.password, PGHOST: c.host, PGPORT: c.port, PGUSER: c.user });

function run(cmd: string, args: string[], c: Conn, extra: string[] = []) {
  return execFileSync(bin(cmd), [...extra, ...args], { env: pgEnv(c), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const psql = (c: Conn, database: string, sql: string) => run("psql", ["-X", "-A", "-t", "-q", "-d", database, "-c", sql], c).trim();

const secs = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function main() {
  const target = assertDisposableDatabase(process.env, "backup and restore drill");
  const src = parse(process.env.DATABASE_URL!);
  const scratch = `${SCRATCH_PREFIX}_${Date.now()}`;
  if (!scratch.startsWith(SCRATCH_PREFIX) || scratch === src.database) throw new Error("scratch database name is unsafe");
  const dumpFile = path.join(os.tmpdir(), `${scratch}.dump`);
  console.log(`Restore drill: ${target.host}/${target.database} -> ${target.host}/${scratch}\n`);

  let created = false;
  try {
    const tables = psql(src, src.database, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`).split("\n").filter(Boolean);
    const sizeMb = Number(psql(src, src.database, `SELECT round(pg_database_size('${src.database}')/1024.0/1024.0, 1)`));

    let t = Date.now();
    run("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "-f", dumpFile, src.database], src);
    const dumpSecs = secs(t);
    const dumpMb = Math.round((fs.statSync(dumpFile).size / 1024 / 1024) * 10) / 10;

    run("psql", ["-X", "-q", "-d", "postgres", "-c", `CREATE DATABASE "${scratch}"`], src);
    created = true;
    t = Date.now();
    run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "-d", scratch, dumpFile], src);
    const restoreSecs = secs(t);

    console.log("Verification");
    check("every table restored", psql(src, scratch, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`) === String(tables.length), `${tables.length} tables`);

    const mismatched: string[] = [];
    let rows = 0;
    for (const table of tables) {
      // row count + content checksum (order-independent), computed identically on both sides
      const sql = `SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM "${table}" x`;
      const a = psql(src, src.database, sql);
      const b = psql(src, scratch, sql);
      rows += Number(a.split(":")[0]);
      if (a !== b) mismatched.push(table);
    }
    check("row counts and content checksums match on every table", mismatched.length === 0, mismatched.length ? `differs: ${mismatched.join(", ")}` : `${rows} rows`);

    const mig = (db: string) => psql(src, db, `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    check("all Prisma migrations recorded as applied", mig(src.database) === mig(scratch), `${mig(scratch)} migrations`);
    check("sequences/constraints intact (constraint count equal)", psql(src, src.database, `SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'`) === psql(src, scratch, `SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'`));
    check("index count equal", psql(src, src.database, `SELECT count(*) FROM pg_indexes WHERE schemaname='public'`) === psql(src, scratch, `SELECT count(*) FROM pg_indexes WHERE schemaname='public'`));

    // the application's own view of the restored copy: migrate status and schema drift
    const scratchUrl = urlFor(src, scratch);
    const prisma = (args: string[]) => spawnSync("npx", ["prisma", ...args], { env: { ...process.env, DATABASE_URL: scratchUrl, DATABASE_URL_UNPOOLED: scratchUrl }, encoding: "utf8" });
    const status = prisma(["migrate", "status"]);
    check("prisma migrate status: schema up to date", status.status === 0 && /up to date/i.test(status.stdout), status.status === 0 ? undefined : (status.stdout + status.stderr).slice(-200));
    const drift = prisma(["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]);
    check("schema drift: none", drift.status === 0, drift.status === 0 ? undefined : (drift.stdout + drift.stderr).slice(-200));

    console.log(`\nTimings: dump ${dumpSecs}s (${dumpMb} MB archive from a ${sizeMb} MB database), restore ${restoreSecs}s, ${rows} rows.`);
    console.log("These are a rehearsal on a small local database: production RTO is dominated by provider restore time, see the runbook.");
  } finally {
    if (created) {
      if (!scratch.startsWith(SCRATCH_PREFIX)) throw new Error("refusing to drop a database this drill did not create");
      try {
        run("psql", ["-X", "-q", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${scratch}"`], src);
        console.log(`Scratch database ${scratch} dropped.`);
      } catch (e) {
        console.error(`Could not drop ${scratch}: ${e instanceof Error ? e.message : e}`);
      }
    }
    fs.rmSync(dumpFile, { force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "\nRESTORE DRILL PASSED" : `\nRESTORE DRILL FAILED (${failed.length} check(s))`);
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error(`[restore-drill] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
