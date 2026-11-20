/**
 * M11 P2-T1/P3-T5: the deploy configuration never mutates the database during a build, and the scheduled jobs point at
 * real, bearer-protected internal routes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")) as { buildCommand: string; crons?: { path: string; schedule: string }[] };
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** Expands `npm run <x>` references so the check sees the whole command the build runs. */
function expand(cmd: string, seen = new Set<string>()): string {
  return cmd.replace(/npm run (?:-s )?([\w:-]+)/g, (_, name: string) => {
    if (seen.has(name) || !pkg.scripts[name]) return `npm run ${name}`;
    seen.add(name);
    return expand(pkg.scripts[name], seen);
  });
}

describe("build never writes to the database (F01)", () => {
  it("the Vercel build command, fully expanded, has no db push, migrate, seed, reset or ad-hoc execute", () => {
    expect(vercel.buildCommand).toBe("npm run vercel-build");
    for (const script of ["vercel-build", "build", "postinstall"]) {
      const full = expand(`npm run ${script}`);
      expect(full, script).not.toMatch(/db push|migrate (deploy|dev|reset|resolve)|db execute|seed|db:setup|db:migrate|db:restore|db:cleanup/);
    }
  });

  it("vercel-build runs the configuration gate first", () => {
    expect(pkg.scripts["vercel-build"].startsWith("npm run env:check")).toBe(true);
  });
});

describe("scheduled jobs (F13)", () => {
  const crons = vercel.crons ?? [];
  it("expire, reconcile and outbox are scheduled at least every 15 minutes", () => {
    expect(crons.map((c) => c.path).sort()).toEqual(["/api/internal/orders/expire", "/api/internal/outbox/process", "/api/internal/payments/reconcile"]);
    for (const c of crons) expect(c.schedule, c.path).toMatch(/^(\*\/(5|10|15)|[\d,]+) \* \* \* \*$/);
  });

  it("every scheduled path is a GET route that requires the CRON_SECRET bearer", () => {
    for (const c of crons) {
      const file = path.join(root, "src/app", c.path, "route.ts");
      const src = fs.readFileSync(file, "utf8");
      expect(src, c.path).toMatch(/export async function GET/);
      expect(src, c.path).toMatch(/CRON_SECRET/);
      expect(src, c.path).toMatch(/safeEqual\(/);
    }
  });
});
