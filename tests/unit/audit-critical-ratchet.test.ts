/**
 * M11 P1-T4 ratchet: a CRITICAL action's success is only ever audited inside the transaction that makes the change
 * (`writeAuditTx`). A best-effort `writeAudit({ action: "<critical>", outcome: "success" … })` anywhere in src/ or
 * scripts/ would let the change commit without its evidence, so it fails this test.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRITICAL_AUDIT_ACTIONS } from "@/lib/auth/audit";

const root = path.resolve(__dirname, "../..");
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

describe("critical audit ratchet", () => {
  const sources = [...files(path.join(root, "src")), ...files(path.join(root, "scripts"))].map((f) => ({ f: path.relative(root, f), s: fs.readFileSync(f, "utf8") }));

  it("no best-effort success audit for a critical action", () => {
    const offenders: string[] = [];
    for (const { f, s } of sources) {
      for (const m of s.matchAll(/writeAudit\(\{([^}]*)/g)) {
        const call = m[1];
        const action = /action:\s*"([^"]+)"/.exec(call)?.[1];
        if (action && (CRITICAL_AUDIT_ACTIONS as readonly string[]).includes(action) && /outcome:\s*"success"/.test(call)) offenders.push(`${f}: ${action}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every critical action is written in-transaction by its owning module", () => {
    const owners: Record<string, string> = {
      "order.update": "src/lib/orders/admin-update.ts",
      "order.refund.requested": "src/lib/payments/refunds.ts",
      "user.create": "src/lib/auth/users.ts",
      "user.update": "src/lib/auth/users.ts",
      "user.password_reset": "src/lib/auth/users.ts",
      "password.change": "src/lib/auth/users.ts",
      "owner.recover": "src/lib/auth/users.ts",
      // M12 VA-05: financial configuration
      "tax_rate.create": "src/app/api/admin/tax-rates/route.ts",
      "shipping_rule.create": "src/app/api/admin/shipping-rules/route.ts",
      "shipping_rule.update": "src/app/api/admin/shipping-rules/[id]/route.ts",
      "shipping_rule.delete": "src/app/api/admin/shipping-rules/[id]/route.ts",
      "price_list.create": "src/app/api/admin/price-lists/route.ts",
      "price_list.update": "src/app/api/admin/price-lists/[id]/route.ts",
      "price_list.delete": "src/app/api/admin/price-lists/[id]/route.ts",
      "price_list.items": "src/app/api/admin/price-lists/[id]/items/route.ts",
      "business_account.update": "src/lib/wholesale/accounts.ts",
      "enquiry.convert": "src/lib/wholesale/accounts.ts",
      "variant.price": "src/app/api/admin/variants/[id]/route.ts",
      "variant.wholesale": "src/app/api/admin/variants/[id]/wholesale/route.ts",
    };
    expect(Object.keys(owners).sort()).toEqual([...CRITICAL_AUDIT_ACTIONS].sort());
    for (const [action, file] of Object.entries(owners)) {
      const s = sources.find((x) => x.f === file)!.s;
      expect(s, `${file} must write ${action} with writeAuditTx`).toMatch(new RegExp(`writeAuditTx\\(tx, \\{ action: "${action.replace(/\./g, "\\.")}"`));
    }
  });
});
