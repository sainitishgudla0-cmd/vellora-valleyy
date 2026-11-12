/**
 * M2-T1: Order.status / paymentStatus / paymentMethod are native Postgres enums (ADR 0005).
 * These tests pin the supported values (the legacy strings), the admin API boundary, and the migration SQL.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@prisma/client";
import { ORDER_STATUSES } from "@/components/admin/statuses";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { PAYABLE_PAYMENT_STATUSES } from "@/lib/payment-verification";
import { orderSchema } from "@/lib/validation";

const svc = vi.hoisted(() => ({ updateOrderAsAdmin: vi.fn() }));
const authMock = vi.hoisted(() => ({ isAdmin: vi.fn() }));
vi.mock("@/lib/orders/admin-update", () => svc);
vi.mock("@/lib/admin-auth", () => authMock);

import { PATCH } from "@/app/api/admin/orders/[id]/route";

// The exact strings stored before the migration. Changing any of these is a data migration.
const LEGACY_STATUS = ["pending_confirmation", "awaiting_payment", "confirmed", "paid", "dispatched", "delivered", "cancelled"];
const LEGACY_PAYMENT_STATUS = ["unpaid", "paid", "failed", "refunded"];
const LEGACY_PAYMENT_METHOD = ["cod", "razorpay"];

describe("enum values are the legacy strings (serialisation unchanged)", () => {
  it("OrderStatus / PaymentStatus / PaymentMethod", () => {
    expect(Object.values(OrderStatus)).toEqual(LEGACY_STATUS);
    expect(Object.values(PaymentStatus)).toEqual(LEGACY_PAYMENT_STATUS);
    expect(Object.values(PaymentMethod)).toEqual(LEGACY_PAYMENT_METHOD);
  });

  it("JSON serialisation of an order's fields is identical to the string era", () => {
    const order = { status: OrderStatus.pending_confirmation, paymentMethod: PaymentMethod.cod, paymentStatus: PaymentStatus.unpaid };
    expect(JSON.stringify(order)).toBe('{"status":"pending_confirmation","paymentMethod":"cod","paymentStatus":"unpaid"}');
  });

  it("frontend copies of the lists cannot drift from the database enums", () => {
    expect(ORDER_STATUSES.map((s) => s.value)).toEqual(Object.values(OrderStatus));
    expect(Object.keys(ORDER_STATUS_LABEL).sort()).toEqual([...Object.values(OrderStatus)].sort());
    for (const s of PAYABLE_PAYMENT_STATUSES) expect(Object.values(PaymentStatus)).toContain(s);
    const methodSchema = orderSchema.shape.paymentMethod;
    expect([...methodSchema.options].sort()).toEqual([...Object.values(PaymentMethod)].sort());
  });
});

describe("PATCH /api/admin/orders/[id] enum boundary", () => {
  const call = (body: unknown) =>
    PATCH(new Request("http://localhost/api/admin/orders/o1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "o1" }) });

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.isAdmin.mockResolvedValue(true);
    svc.updateOrderAsAdmin.mockResolvedValue({ ok: true, changed: true });
  });

  it.each(LEGACY_STATUS)("accepts status %s", async (status) => {
    expect((await call({ status })).status).toBe(200);
    expect(svc.updateOrderAsAdmin).toHaveBeenCalledWith({ orderId: "o1", status });
  });

  it.each(LEGACY_PAYMENT_STATUS)("accepts paymentStatus %s", async (paymentStatus) => {
    expect((await call({ paymentStatus, reason: "r" })).status).toBe(200);
    expect(svc.updateOrderAsAdmin).toHaveBeenCalledWith({ orderId: "o1", paymentStatus, reason: "r" });
  });

  it.each([{ status: "shipped" }, { status: "PAID" }, { status: " paid" }, { status: "" }, { status: null }, { paymentStatus: "settled" }, { paymentStatus: "Unpaid" }, { reason: "x".repeat(501) }, { paymentReference: "x".repeat(81) }])(
    "rejects unsupported value %j with 422 and never reaches the service",
    async (body) => {
      expect((await call(body)).status).toBe(422);
      expect(svc.updateOrderAsAdmin).not.toHaveBeenCalled();
    },
  );

  it("requires an admin session", async () => {
    authMock.isAdmin.mockResolvedValue(false);
    expect((await call({ status: "paid" })).status).toBe(401);
    expect(svc.updateOrderAsAdmin).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, code: "not_found", message: "m" }, 404],
    [{ ok: false, code: "reason_required", message: "m" }, 422],
    [{ ok: false, code: "reference_required", message: "m" }, 422],
    [{ ok: false, code: "invalid_transition", message: "m" }, 409],
    [{ ok: false, code: "actor_not_allowed", message: "m" }, 409],
    [{ ok: false, code: "stale_state", message: "m" }, 409],
    [{ ok: false, code: "payment_edit_not_allowed", message: "m" }, 409],
    [{ ok: false, code: "reference_in_use", message: "m" }, 409],
  ])("maps service result %j to HTTP %i", async (result, status) => {
    svc.updateOrderAsAdmin.mockResolvedValue(result);
    expect((await call({ status: "confirmed" })).status).toBe(status);
  });
});

describe("order checkout input still accepts only supported payment methods", () => {
  it("rejects methods outside the enum", () => {
    const base = { paymentMethod: "bank_transfer", items: [{ variantId: "v", quantity: 1 }] };
    const r = orderSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "paymentMethod")).toBe(true);
  });
});

describe("migration SQL 20261112021101_order_payment_enums", () => {
  const dir = path.join(process.cwd(), "prisma/migrations");
  const name = fs.readdirSync(dir).find((d) => d.endsWith("_order_payment_enums"))!;
  const sql = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  const labels = (t: string) => new RegExp(`CREATE TYPE "${t}" AS ENUM \\(([^)]*)\\)`).exec(sql)![1].match(/'([^']+)'/g)!.map((x) => x.slice(1, -1));

  it("creates enums whose labels equal the Prisma enums", () => {
    expect(labels("OrderStatus")).toEqual(Object.values(OrderStatus));
    expect(labels("PaymentStatus")).toEqual(Object.values(PaymentStatus));
    expect(labels("PaymentMethod")).toEqual(Object.values(PaymentMethod));
  });

  it("converts in place with USING casts and never drops or recreates columns", () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|DROP TABLE/i);
    for (const c of ["status", "paymentMethod", "paymentStatus"]) expect(sql).toMatch(new RegExp(`ALTER COLUMN "${c}" TYPE "\\w+" USING`));
    expect(sql).toMatch(/SET DEFAULT 'unpaid'/);
  });

  it("locks the table and pre-checks before any DDL change", () => {
    const lock = sql.indexOf('LOCK TABLE "Order"');
    const check = sql.indexOf("RAISE EXCEPTION");
    const firstDdl = sql.indexOf("CREATE TYPE");
    expect(lock).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(lock);
    expect(firstDdl).toBeGreaterThan(check);
  });

  it("pre-check allow-lists match the enum labels exactly", () => {
    const list = (col: string) => new RegExp(`WHERE "${col}" NOT IN \\(([^)]*)\\)`).exec(sql)![1].match(/'([^']+)'/g)!.map((x) => x.slice(1, -1));
    expect(list("status")).toEqual(Object.values(OrderStatus));
    expect(list("paymentStatus")).toEqual(Object.values(PaymentStatus));
    expect(list("paymentMethod")).toEqual(Object.values(PaymentMethod));
  });
});
