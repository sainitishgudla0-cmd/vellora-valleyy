/**
 * M8-T6: the API contract document and the route files cannot drift apart, and no route is untested.
 *  - every route file is documented in docs/API-CONTRACTS.md (full path, or the `…/[id]` shorthand under its parent);
 *  - every route documented with a full `METHOD /api/...` path exists and exports exactly the documented methods;
 *  - every route is exercised: its handler is imported by a test, or the API smoke test calls its path.
 * Behavioural contracts (status codes, body shapes, authz) live in the integration suites that import those handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = "src/app/api";
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "route.ts" ? [path.join(d, e.name)] : []));
const norm = (p: string) => p.replace(/\[[^\]]+\]/g, "[]");

const routes = walk(API_ROOT).map((file) => {
  const f = file.split(path.sep).join("/");
  const route = "/api" + f.slice(API_ROOT.length).replace(/\/route\.ts$/, "");
  const methods = [...fs.readFileSync(f, "utf8").matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]).sort();
  return { file: f, route, methods };
});

const doc = fs.readFileSync("docs/API-CONTRACTS.md", "utf8");
const docNorm = norm(doc);

const listTests = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "__screenshots__" ? [] : e.isDirectory() ? listTests(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
const testSource = listTests("tests").map((f) => fs.readFileSync(f, "utf8")).join("\n");
const smoke = fs.readFileSync("scripts/smoke-test.ts", "utf8");

function documented(route: string): boolean {
  const n = norm(route);
  if (docNorm.includes(n)) return true;
  const seg = n.split("/").filter(Boolean);
  for (let k = 1; k < seg.length - 1; k++) {
    const parent = "/" + seg.slice(0, seg.length - k).join("/");
    const tail = seg.slice(seg.length - k).join("/");
    if (docNorm.includes(parent) && docNorm.includes(`…/${tail}`)) return true;
  }
  return false;
}

describe("API contract coverage", () => {
  it("finds the routes (the scan is not vacuous)", () => expect(routes.length).toBeGreaterThanOrEqual(60));

  it.each(routes.map((r) => [r.route, r] as const))("%s is documented in API-CONTRACTS.md", (_r, r) => {
    expect(documented(r.route), `${r.route} (${r.methods.join(",")}) is missing from docs/API-CONTRACTS.md`).toBe(true);
  });

  it.each(routes.map((r) => [r.route, r] as const))("%s is exercised by a test or the smoke test", (_r, r) => {
    const imported = testSource.includes(`@/${r.file.slice("src/".length).replace(/\.ts$/, "")}`);
    const staticPrefix = r.route.split("[")[0].replace(/\/$/, "");
    expect(imported || smoke.includes(r.route) || smoke.includes(staticPrefix), `${r.route} has no contract test`).toBe(true);
  });

  it("every route documented with a full METHOD /api/path exists and exports those methods", () => {
    const byRoute = new Map(routes.map((r) => [norm(r.route), r]));
    const found = [...doc.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*) (\/api(?:\/(?:[A-Za-z0-9_-]+|\[[A-Za-z]+\]))+)/g)];
    expect(found.length).toBeGreaterThan(40);
    const problems: string[] = [];
    for (const [, methods, p] of found) {
      const r = byRoute.get(norm(p));
      if (!r) {
        problems.push(`${methods} ${p}: documented but there is no route file`);
        continue;
      }
      for (const m of methods.split("/")) if (!r.methods.includes(m)) problems.push(`${m} ${p}: documented but the route does not export ${m}`);
    }
    expect(problems).toEqual([]);
  });

  it("self-test: the drift detector flags a missing route and a missing method", () => {
    expect(documented("/api/this/route/does-not-exist")).toBe(false);
    expect(norm("/api/x/[slug]/y/[id]")).toBe("/api/x/[]/y/[]");
  });
});
