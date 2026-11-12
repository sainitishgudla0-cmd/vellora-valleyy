/** M8: the guest invoice download (order access token) and the tests-only mock OTP lookup (must not exist outside disposable test/dev). */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/state-machine";
import { issueInvoice } from "@/lib/invoices/issue";
import { issueOtp } from "@/lib/auth/otp";
import { mockOtpOutbox } from "@/lib/auth/otp-sender";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail } from "../support/customer";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupFulfilmentFixtures, fulfilmentEnv, placeCod, setRate } from "../support/fulfilment";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { GET as guestInvoice } from "@/app/api/orders/[number]/invoice/route";
import { GET as otpLookup } from "@/app/api/internal/test-environment/otp/route";
import { POST as retailOrder } from "@/app/api/orders/route";

const inv = (number: string, t?: string) => guestInvoice(new Request(`http://localhost/api/orders/${number}/invoice${t === undefined ? "" : `?t=${encodeURIComponent(t)}`}`), { params: Promise.resolve({ number }) });
const lookup = (email: string) => otpLookup(new Request(`http://localhost/api/internal/test-environment/otp?email=${encodeURIComponent(email)}`));
let variantId: string;

beforeEach(async () => {
  fulfilmentEnv();
  customerTestEnv();
  rate.rateLimit.mockResolvedValue(true);
  await db.otpChallenge.deleteMany({});
  mockOtpOutbox.length = 0;
  variantId ??= (await createInventoryVariant({ tracked: false, price: 10500 })).variantId;
  await setRate("0802", 500);
});
afterAll(async () => {
  await cleanupFulfilmentFixtures();
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("GET /api/orders/[number]/invoice (guest download by access token)", () => {
  it("serves the PDF to the holder of the token, with private no-store headers; wrong, missing, uninvoiced and unknown are the same 404", async () => {
    const o = await placeCod(variantId);
    const bare = await inv(o.number, o.accessToken);
    expect(bare.status).toBe(404); // not invoiced yet
    await transitionOrder({ orderId: o.id, from: "pending_confirmation", to: "confirmed", actor: { type: "admin", id: "t" }, reason: "ok" });
    const issued = await issueInvoice(o.id);
    if (!issued.ok) throw new Error(issued.message);
    const ok = await inv(o.number, o.accessToken);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment; filename="VV-\d\d-\d\d-\d{6}\.pdf"$/);
    expect(Buffer.from(await ok.arrayBuffer()).toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    const other = await placeCod(variantId);
    for (const [num, t] of [[o.number, "wrong-token"], [o.number, ""], [o.number, other.accessToken], ["VV-000000-NOPE00", o.accessToken]] as const) expect((await inv(num, t)).status, `${num} ${t}`).toBe(404);
    expect((await inv(o.number)).status).toBe(404);
    rate.rateLimit.mockResolvedValue(false);
    expect((await inv(o.number, o.accessToken)).status).toBe(429);
  });
});

describe("POST /api/orders: unserviceable pincode is reported against the pincode field (M8-T1)", () => {
  it("returns 422 with `fields.pincode` so the checkout form can show it next to the input", async () => {
    await db.shippingRule.deleteMany({});
    await db.shippingRule.create({ data: { name: "Andhra only", pincodePrefix: "51", fee: 0 } });
    const res = await retailOrder(new Request("http://localhost/api/orders", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ customerName: "SMOKE TEST Stock", email: "smoke.m8@m5-fixture.example.com", phone: "9876543210", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", paymentMethod: "cod", items: [{ variantId, quantity: 1 }] }) }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Sorry, we do not deliver to this pincode yet.", fields: { pincode: "We do not deliver to this pincode yet" } });
    await db.shippingRule.deleteMany({});
  });
});

describe("GET /api/internal/test-environment/otp (tests only)", () => {
  it("returns the newest mock code on a disposable test server in mock mode, and 404 for an address with none", async () => {
    const email = freshEmail();
    expect((await lookup(email)).status).toBe(404);
    expect((await issueOtp(email)).ok).toBe(true);
    const r = await lookup(email);
    expect(r.status).toBe(200);
    const { code } = await r.json();
    expect(code).toMatch(/^\d{6}$/);
    expect(code).toBe(mockOtpOutbox.find((o) => o.email === email)!.code);
    expect((await lookup(email.toUpperCase())).status).toBe(200); // addresses are matched case-insensitively
  });

  it("does not exist in production or preview (even with mock mode set), without mock mode, or without a disposable-database declaration", async () => {
    const email = freshEmail();
    await issueOtp(email);
    for (const appEnv of ["production", "preview"]) {
      vi.stubEnv("APP_ENV", appEnv);
      expect((await lookup(email)).status, appEnv).toBe(404);
    }
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("CUSTOMER_OTP_MODE", "");
    expect((await lookup(email)).status).toBe(404);
    vi.stubEnv("CUSTOMER_OTP_MODE", "mock");
    vi.stubEnv("TEST_TARGET", "");
    expect((await lookup(email)).status).toBe(404);
    vi.stubEnv("TEST_TARGET", "disposable");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/app");
    expect((await lookup(email)).status).toBe(404); // a non-loopback database is not disposable
  });
});
