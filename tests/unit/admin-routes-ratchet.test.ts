/**
 * Ratchet for the M4 acceptance criteria "no admin route without requireAdmin" and "audit completeness"
 * (ADR 0012). Every route handler under src/app/api/admin is checked statically:
 *  - each handler calls requireAdmin(req, "<permission>") — except login and logout, which have no session to
 *    require and use requireSameOrigin instead (they are the only entries in PRE_SESSION);
 *  - each state-changing handler (anything but GET) writes an audit row, directly or through the login service.
 * The old shared-cookie helper `isAdmin` may not be used by any API route.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/app/api/admin";
const PRE_SESSION = new Set(["src/app/api/admin/login/route.ts", "src/app/api/admin/logout/route.ts"]);
const AUDIT_VIA_SERVICE = new Set(["src/app/api/admin/login/route.ts"]); // loginWithPassword / loginLegacy audit every outcome

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));

export function handlers(src: string): { method: string; body: string }[] {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  const found = [...src.matchAll(re)];
  return found.map((m, i) => ({ method: m[1], body: src.slice(m.index!, found[i + 1]?.index ?? src.length) }));
}

const files = walk(ROOT).map((f) => f.split(path.sep).join("/"));

describe("admin routes", () => {
  it("finds the routes (self-test: the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(handlers("export async function GET() {}\nexport async function PATCH() {}").map((h) => h.method)).toEqual(["GET", "PATCH"]);
  });

  it.each(files)("%s: every handler is gated and every mutation audited", (file) => {
    const src = fs.readFileSync(file, "utf8");
    const hs = handlers(src);
    expect(hs.length, `${file} exports no handler`).toBeGreaterThan(0);
    for (const h of hs) {
      if (PRE_SESSION.has(file)) expect(h.body, `${file} ${h.method}`).toContain("requireSameOrigin(");
      else expect(h.body, `${file} ${h.method} must call requireAdmin`).toMatch(/requireAdmin\(\s*req\s*,\s*"[a-z]+:[a-z]+"\s*\)/);
      if (h.method !== "GET" && !AUDIT_VIA_SERVICE.has(file)) expect(h.body, `${file} ${h.method} must write an audit row`).toContain("writeAudit(");
    }
  });

  it("no API route uses the old cookie helper", () => {
    for (const f of walk("src/app/api")) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/\bisAdmin\b/);
  });
});
