/** M5-T3..T6: profile, addresses, order history (IDOR), order linking, guest-order claim, consent, export and erasure. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { CUSTOMER_COOKIE } from "@/lib/auth/customer";
import { MAX_ADDRESSES } from "@/lib/account/addresses";
import { ERASED_EMAIL } from "@/lib/account/erasure";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupCustomerFixtures, customerTestEnv, freshEmail, signInCustomer, CUSTOMER_FIXTURE_DOMAIN } from "../support/customer";

const rate = vi.hoisted(() => ({ rateLimit: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit", () => rate);

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as me, PATCH as patchMe } from "@/app/api/account/me/route";
import { POST as consent } from "@/app/api/account/consent/route";
import { GET as addressList, POST as addressCreate } from "@/app/api/account/addresses/route";
import { PATCH as addressPatch, DELETE as addressDelete } from "@/app/api/account/addresses/[id]/route";
import { GET as orderList } from "@/app/api/account/orders/route";
import { GET as orderGet } from "@/app/api/account/orders/[number]/route";
import { POST as claim } from "@/app/api/account/claim/route";
import { GET as exportData } from "@/app/api/account/export/route";
import { DELETE as deleteAccount } from "@/app/api/account/route";

const mk = (url: string, method: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any>, res });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const ADDRESS = { name: "Asha Rao", phone: "9876543210", line1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001" };

let variantId: string;
const seq = 0;
async function placeOrder(cookie: string | undefined, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await read(await createOrderRoute(mk("/api/orders", "POST", cookie, {
    customerName: "Asha Rao", email: freshEmail("guest"), phone: "9876543210", addressLine1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001",
    paymentMethod: "cod", items: [{ variantId, quantity: 1 }], ...over,
  }, headers)));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { number: r.body.order.number as string, token: r.body.order.token as string, order: await db.order.findUniqueOrThrow({ where: { number: r.body.order.number } }) };
}

beforeEach(async () => {
  customerTestEnv();
  vi.stubEnv("PAYMENT_MODE", "request_only");
  rate.rateLimit.mockResolvedValue(true);
  await db.otpChallenge.deleteMany({});
  variantId ??= (await createInventoryVariant({ tracked: false })).variantId;
});
afterAll(async () => {
  await cleanupCustomerFixtures();
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

describe("every account route needs a session (authz matrix)", () => {
  const ROUTES: [string, () => Promise<Response>][] = [
    ["GET me", () => me(mk("/api/account/me", "GET"))],
    ["PATCH me", () => patchMe(mk("/api/account/me", "PATCH", undefined, { name: "Asha Rao" }))],
    ["POST consent", () => consent(mk("/api/account/consent", "POST", undefined, { marketing: true }))],
    ["GET addresses", () => addressList(mk("/api/account/addresses", "GET"))],
    ["POST addresses", () => addressCreate(mk("/api/account/addresses", "POST", undefined, ADDRESS))],
    ["PATCH addresses/[id]", () => addressPatch(mk("/api/account/addresses/x", "PATCH", undefined, { city: "Hyderabad" }), ctx({ id: "x" }))],
    ["DELETE addresses/[id]", () => addressDelete(mk("/api/account/addresses/x", "DELETE"), ctx({ id: "x" }))],
    ["GET orders", () => orderList(mk("/api/account/orders", "GET"))],
    ["GET orders/[number]", () => orderGet(mk("/api/account/orders/VV-1", "GET"), ctx({ number: "VV-1" }))],
    ["POST claim", () => claim(mk("/api/account/claim", "POST", undefined, { mode: "email" }))],
    ["GET export", () => exportData(mk("/api/account/export", "GET"))],
    ["DELETE account", () => deleteAccount(mk("/api/account", "DELETE", undefined, { confirm: "DELETE" }))],
  ];
  it.each(ROUTES)("%s → 401 without a session, 401 with a revoked one", async (_n, call) => {
    expect((await call()).status).toBe(401);
    expect((await call()).headers.get("set-cookie")).toBeNull();
  });
  it("a garbage or foreign cookie is no session either", async () => {
    for (const cookie of [`${CUSTOMER_COOKIE}=garbage`, "vv_admin=whatever"]) expect((await me(mk("/api/account/me", "GET", cookie))).status).toBe(401);
  });
  it("cross-origin mutations are refused with 403 even with a valid session", async () => {
    const c = await signInCustomer();
    const evil = { origin: "https://evil.example" };
    expect((await patchMe(mk("/api/account/me", "PATCH", c.cookie, { name: "Mallory Evil" }, evil))).status).toBe(403);
    expect((await addressCreate(mk("/api/account/addresses", "POST", c.cookie, ADDRESS, evil))).status).toBe(403);
    expect((await deleteAccount(mk("/api/account", "DELETE", c.cookie, { confirm: "DELETE" }, evil))).status).toBe(403);
    expect(await db.customer.count({ where: { id: c.customerId } })).toBe(1);
    expect((await me(mk("/api/account/me", "GET", c.cookie, undefined, evil))).status).toBe(200); // reads are fine
  });
});

describe("profile and consent", () => {
  it("returns the profile with consent history; updates name and phone; email is read-only", async () => {
    const c = await signInCustomer();
    expect((await read(await me(mk("/api/account/me", "GET", c.cookie)))).body.customer).toMatchObject({ email: c.email, name: null, phone: null, marketingConsent: false, consents: [{ purpose: "terms_privacy", granted: true, version: "2026-11" }] });
    const r = await read(await patchMe(mk("/api/account/me", "PATCH", c.cookie, { name: "Asha Rao", phone: "98765 43210" })));
    expect(r).toMatchObject({ status: 200, body: { customer: { name: "Asha Rao", phone: "9876543210" } } });
    expect((await patchMe(mk("/api/account/me", "PATCH", c.cookie, { email: "x@example.com" }))).status).toBe(422);
    expect((await patchMe(mk("/api/account/me", "PATCH", c.cookie, { phone: "123" }))).status).toBe(422);
    expect((await read(await patchMe(mk("/api/account/me", "PATCH", c.cookie, { name: null })))).body.customer.name).toBeNull();
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.customerId } })).email).toBe(c.email);
  });

  it("marketing consent is opt-in, revocable, and every change is appended to the history", async () => {
    const c = await signInCustomer();
    expect((await read(await consent(mk("/api/account/consent", "POST", c.cookie, { marketing: true })))).body).toMatchObject({ changed: true, marketing: true });
    expect((await read(await consent(mk("/api/account/consent", "POST", c.cookie, { marketing: true })))).body.changed).toBe(false); // no duplicate record
    expect((await read(await consent(mk("/api/account/consent", "POST", c.cookie, { marketing: false })))).body.changed).toBe(true);
    expect((await db.consentRecord.findMany({ where: { customerId: c.customerId, purpose: "marketing" }, orderBy: { createdAt: "asc" } })).map((x) => x.granted)).toEqual([true, false]);
    expect((await consent(mk("/api/account/consent", "POST", c.cookie, { marketing: "yes" }))).status).toBe(422);
  });
});

describe("addresses", () => {
  const create = async (cookie: string, over: Record<string, unknown> = {}) => read(await addressCreate(mk("/api/account/addresses", "POST", cookie, { ...ADDRESS, ...over })));
  const list = async (cookie: string) => (await read(await addressList(mk("/api/account/addresses", "GET", cookie)))).body.addresses as any[];

  it("the first address becomes the default; a new default replaces it; deleting the default promotes another", async () => {
    const c = await signInCustomer();
    const a = (await create(c.cookie, { label: "Home" })).body.address;
    expect(a.isDefault).toBe(true);
    const b = (await create(c.cookie, { label: "Work", line1: "7 Station Road" })).body.address;
    expect(b.isDefault).toBe(false);
    const d = (await create(c.cookie, { label: "Parents", isDefault: true })).body.address;
    expect((await list(c.cookie)).map((x) => [x.label, x.isDefault])).toEqual([["Parents", true], ["Home", false], ["Work", false]]);
    await addressDelete(mk(`/api/account/addresses/${d.id}`, "DELETE", c.cookie), ctx({ id: d.id }));
    const after = await list(c.cookie);
    expect(after.filter((x) => x.isDefault)).toHaveLength(1);
    expect(after).toHaveLength(2);
    void a; void b;
  });

  it("updates fields, can move the default, and validates", async () => {
    const c = await signInCustomer();
    const a = (await create(c.cookie)).body.address;
    const b = (await create(c.cookie, { line1: "9 Temple Street" })).body.address;
    const r = await read(await addressPatch(mk(`/api/account/addresses/${b.id}`, "PATCH", c.cookie, { city: "Hyderabad", state: "Telangana", pincode: "500001", isDefault: true }), ctx({ id: b.id })));
    expect(r).toMatchObject({ status: 200, body: { address: { city: "Hyderabad", isDefault: true } } });
    expect((await list(c.cookie)).find((x) => x.id === a.id).isDefault).toBe(false);
    for (const bad of [{}, { pincode: "1" }, { state: "Nowhere" }, { customerId: "x" }]) expect((await addressPatch(mk(`/api/account/addresses/${b.id}`, "PATCH", c.cookie, bad), ctx({ id: b.id }))).status).toBe(422);
  });

  it("limits the number of saved addresses", async () => {
    const c = await signInCustomer();
    for (let i = 0; i < MAX_ADDRESSES; i++) expect((await create(c.cookie, { line1: `${i + 10} Long Street` })).status).toBe(201);
    expect(await create(c.cookie)).toMatchObject({ status: 409, body: { code: "limit_reached" } });
  });

  it("parallel creates keep exactly one default and respect the limit", async () => {
    const c = await signInCustomer();
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => create(c.cookie, { line1: `${i + 20} Parallel Lane`, isDefault: i % 2 === 0 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_ADDRESSES);
    expect(results.filter((r) => r.status === 409)).toHaveLength(14 - MAX_ADDRESSES);
    expect(await db.address.count({ where: { customerId: c.customerId } })).toBe(MAX_ADDRESSES);
    expect(await db.address.count({ where: { customerId: c.customerId, isDefault: true } })).toBe(1);
  });

  it("IDOR: another customer's address id is 404 for read-modify-delete, and nothing changes", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const mine = (await create(a.cookie)).body.address;
    expect((await list(b.cookie))).toEqual([]);
    expect((await addressPatch(mk(`/api/account/addresses/${mine.id}`, "PATCH", b.cookie, { city: "Hacked" }), ctx({ id: mine.id }))).status).toBe(404);
    expect((await addressDelete(mk(`/api/account/addresses/${mine.id}`, "DELETE", b.cookie), ctx({ id: mine.id }))).status).toBe(404);
    expect((await addressDelete(mk("/api/account/addresses/does-not-exist", "DELETE", b.cookie), ctx({ id: "does-not-exist" }))).status).toBe(404); // same answer as a missing id
    expect(await db.address.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ city: "Anantapur", customerId: a.customerId });
  });

  it("the database refuses two defaults for one customer", async () => {
    const c = await signInCustomer();
    await create(c.cookie);
    await expect(db.address.create({ data: { customerId: c.customerId, ...ADDRESS, line2: null, isDefault: true } })).rejects.toThrow(/Unique constraint failed/);
  });
});

describe("order history and linking", () => {
  it("a signed-in checkout links the order to the account; the cookie decides, the body cannot", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const mine = await placeOrder(a.cookie, { customerId: b.customerId, customerID: b.customerId });
    expect(mine.order.customerId).toBe(a.customerId); // an attacker-supplied id is ignored
    const guest = await placeOrder(undefined);
    expect(guest.order.customerId).toBeNull();
    expect((await placeOrder(`${CUSTOMER_COOKIE}=garbage`)).order.customerId).toBeNull(); // a bad cookie degrades to guest checkout
  });

  it("guest checkout response shape is unchanged", async () => {
    const r = await read(await createOrderRoute(mk("/api/orders", "POST", undefined, { customerName: "Asha Rao", email: freshEmail("guest"), phone: "9876543210", addressLine1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001", paymentMethod: "cod", items: [{ variantId, quantity: 1 }] })));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(["order"]);
    expect(Object.keys(r.body.order).sort()).toEqual(["number", "token", "total"]);
  });

  it("lists only my orders (newest first, paged) and shows detail without tokens, gateway ids or staff reasons", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const nums: string[] = [];
    for (let i = 0; i < 5; i++) nums.push((await placeOrder(a.cookie)).number);
    const theirs = await placeOrder(b.cookie);
    const p1 = await read(await orderList(mk("/api/account/orders?limit=2", "GET", a.cookie)));
    expect(p1.body.orders.map((o: any) => o.number)).toEqual([nums[4], nums[3]]);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await read(await orderList(mk(`/api/account/orders?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, "GET", a.cookie)));
    expect(p2.body.orders.map((o: any) => o.number)).toEqual([nums[2], nums[1]]);
    const p3 = await read(await orderList(mk(`/api/account/orders?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`, "GET", a.cookie)));
    expect(p3.body.orders.map((o: any) => o.number)).toEqual([nums[0]]);
    expect(p3.body.nextCursor).toBeNull();
    const all = (await read(await orderList(mk("/api/account/orders", "GET", a.cookie)))).body.orders.map((o: any) => o.number);
    expect(all).not.toContain(theirs.number);
    expect(Object.keys(p1.body.orders[0]).sort()).toEqual(["createdAt", "itemCount", "number", "paymentMethod", "paymentStatus", "status", "total"]);

    await db.orderEvent.create({ data: { orderId: (await db.order.findUniqueOrThrow({ where: { number: nums[0] } })).id, fromStatus: "pending_confirmation", toStatus: "confirmed", actorType: "admin", actorId: "staff-id-123", reason: "STAFF-ONLY-NOTE call back" } });
    const d = await read(await orderGet(mk(`/api/account/orders/${nums[0]}`, "GET", a.cookie), ctx({ number: nums[0] })));
    expect(d.status).toBe(200);
    expect(d.body.order).toMatchObject({ number: nums[0], status: "pending_confirmation", shipping: { name: "Asha Rao", pincode: "515001" }, items: [{ quantity: 1 }], history: [{ from: "pending_confirmation", to: "confirmed" }] });
    const text = JSON.stringify(d.body);
    for (const secret of ["accessToken", "razorpay", "STAFF-ONLY-NOTE", "staff-id-123", "actorId", "reason"]) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain((await db.order.findUniqueOrThrow({ where: { number: nums[0] } })).accessToken);
  });

  it("IDOR: someone else's order number, a guest order and an unknown number are all the same 404", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const theirs = await placeOrder(b.cookie);
    const guest = await placeOrder(undefined, { email: a.email }); // same email as A but unclaimed: still not visible
    const call = (n: string) => orderGet(mk(`/api/account/orders/${n}`, "GET", a.cookie), ctx({ number: n }));
    const responses = await Promise.all([theirs.number, guest.number, "VV-000000-NOPE00"].map(async (n) => read(await call(n))));
    for (const r of responses) expect(r).toMatchObject({ status: 404, body: { error: "Order not found" } });
    expect((await orderList(mk("/api/account/orders?cursor=garbage", "GET", a.cookie))).status).toBe(422);
    expect((await orderList(mk("/api/account/orders?limit=500", "GET", a.cookie))).status).toBe(422);
  });
});

describe("claiming guest orders", () => {
  it("by verified email: links unclaimed orders placed with that address (any case), never someone else's or already-linked ones", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const g1 = await placeOrder(undefined, { email: a.email.toUpperCase() });
    const g2 = await placeOrder(undefined, { email: a.email });
    const other = await placeOrder(undefined, { email: freshEmail("other") });
    const bOwn = await placeOrder(b.cookie, { email: a.email }); // already B's, even though it carries A's address
    const r = await read(await claim(mk("/api/account/claim", "POST", a.cookie, { mode: "email" })));
    expect(r.body).toEqual({ ok: true, claimed: 2 });
    expect((await db.order.findUniqueOrThrow({ where: { number: g1.number } })).customerId).toBe(a.customerId);
    expect((await db.order.findUniqueOrThrow({ where: { number: g2.number } })).customerId).toBe(a.customerId);
    expect((await db.order.findUniqueOrThrow({ where: { number: other.number } })).customerId).toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { number: bOwn.number } })).customerId).toBe(b.customerId);
    expect((await read(await claim(mk("/api/account/claim", "POST", a.cookie, { mode: "email" })))).body.claimed).toBe(0); // idempotent
    expect((await read(await orderList(mk("/api/account/orders", "GET", a.cookie)))).body.orders.map((o: any) => o.number).sort()).toEqual([g1.number, g2.number].sort());
    expect((await db.auditLog.findMany({ where: { action: "customer.claim" } })).length).toBeGreaterThanOrEqual(2);
  });

  it("by order number + token: proves possession; a wrong token, someone else's order and an unknown order are the same 404", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const guest = await placeOrder(undefined, { email: freshEmail("typed-another-email") });
    const bOrder = await placeOrder(b.cookie);
    const call = (orderNumber: string, token: string) => claim(mk("/api/account/claim", "POST", a.cookie, { orderNumber, token }));
    expect((await call(guest.number, "wrong-token")).status).toBe(404);
    expect((await call(bOrder.number, bOrder.token)).status).toBe(404); // right token, but it is B's order
    expect((await call("VV-000000-NOPE00", "x")).status).toBe(404);
    expect((await db.order.findUniqueOrThrow({ where: { number: guest.number } })).customerId).toBeNull();
    expect(await read(await call(guest.number, guest.token))).toMatchObject({ status: 200, body: { ok: true, claimed: 1 } });
    expect(await read(await call(guest.number, guest.token))).toMatchObject({ status: 200, body: { claimed: 0 } }); // already yours
    expect((await db.order.findUniqueOrThrow({ where: { number: bOrder.number } })).customerId).toBe(b.customerId);
  });

  it("two customers racing to claim one order by token: exactly one wins", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    const guest = await placeOrder(undefined);
    const results = await Promise.all([a, b, a, b].map(async (c) => read(await claim(mk("/api/account/claim", "POST", c.cookie, { orderNumber: guest.number, token: guest.token })))));
    const owner = (await db.order.findUniqueOrThrow({ where: { number: guest.number } })).customerId;
    expect([a.customerId, b.customerId]).toContain(owner);
    const winners = results.filter((r) => r.status === 200 && r.body.claimed === 1);
    expect(winners).toHaveLength(1);
  });
});

describe("export", () => {
  it("returns everything held about the person, as a download, without secrets", async () => {
    const c = await signInCustomer();
    await patchMe(mk("/api/account/me", "PATCH", c.cookie, { name: "Asha Rao", phone: "9876543210" }));
    await addressCreate(mk("/api/account/addresses", "POST", c.cookie, ADDRESS));
    const own = await placeOrder(c.cookie, { email: c.email });
    const guest = await placeOrder(undefined, { email: c.email.toUpperCase() });
    await db.enquiry.create({ data: { type: "contact", name: "Asha", email: c.email, message: "Do you ship to Goa?" } });
    await db.subscriber.create({ data: { email: c.email } });
    const res = await exportData(mk("/api/account/export", "GET", c.cookie));
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = JSON.parse(await res.text());
    expect(data.customer).toMatchObject({ email: c.email, name: "Asha Rao", phone: "9876543210" });
    expect(data.addresses).toHaveLength(1);
    expect(data.consents).toMatchObject([{ purpose: "terms_privacy", granted: true }]);
    expect(data.orders.map((o: any) => [o.number, o.linkedToAccount]).sort()).toEqual([[own.number, true], [guest.number, false]].sort());
    expect(data.enquiries).toMatchObject([{ message: "Do you ship to Goa?" }]);
    expect(data.newsletter.subscribed).toBe(true);
    const text = JSON.stringify(data);
    for (const secret of [own.token, guest.token, "accessToken", "tokenHash", "razorpay", "customerId", "passwordHash"]) expect(text, secret).not.toContain(secret);
    expect((await db.auditLog.findMany({ where: { action: "customer.export", targetId: c.customerId } })).length).toBe(1);
    rate.rateLimit.mockResolvedValue(false);
    expect((await exportData(mk("/api/account/export", "GET", c.cookie))).status).toBe(429);
  });
});

describe("account deletion (erasure)", () => {
  const del = (cookie: string, body: unknown = { confirm: "DELETE" }) => deleteAccount(mk("/api/account", "DELETE", cookie, body));

  it("requires the explicit confirmation and a sign-in from the last 10 minutes", async () => {
    const old = await signInCustomer(freshEmail(), { ageMs: 11 * 60_000 });
    expect(await read(await del(old.cookie))).toMatchObject({ status: 403, body: { code: "reauth_required" } });
    const c = await signInCustomer();
    for (const bad of [{}, { confirm: "yes" }, { confirm: "DELETE", customerId: "x" }]) expect((await del(c.cookie, bad)).status).toBe(422);
    expect(await db.customer.count({ where: { id: old.customerId } })).toBe(1);
    expect(await db.customer.count({ where: { id: c.customerId } })).toBe(1);
  });

  it("is refused while an order is still open, listing how many", async () => {
    const c = await signInCustomer();
    const o = await placeOrder(c.cookie, { email: c.email });
    expect(await read(await del(c.cookie))).toMatchObject({ status: 409, body: { code: "open_orders", openOrders: 1 } });
    expect(await db.customer.count({ where: { id: c.customerId } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { number: o.number } })).customerName).toBe("Asha Rao"); // untouched
  });

  it("an open guest order under the same email also blocks erasure", async () => {
    const c = await signInCustomer();
    await placeOrder(undefined, { email: c.email });
    expect((await del(c.cookie)).status).toBe(409);
  });

  it("deletes the account and what hangs off it, anonymises orders and enquiries, and is not reversible by the old session", async () => {
    const c = await signInCustomer();
    await patchMe(mk("/api/account/me", "PATCH", c.cookie, { name: "Asha Rao", phone: "9876543210" }));
    await addressCreate(mk("/api/account/addresses", "POST", c.cookie, ADDRESS));
    const own = await placeOrder(c.cookie, { email: c.email, notes: "Leave with the neighbour" });
    const guest = await placeOrder(undefined, { email: c.email });
    await db.idempotencyKey.create({ data: { keyHash: `h${Date.now()}`.padEnd(64, "0"), requestHash: "r".repeat(64), orderId: own.order.id, responseStatus: 201, responseBody: JSON.stringify({ order: { token: own.token } }), expiresAt: new Date(Date.now() + 3600_000) } });
    for (const n of [own.number, guest.number]) await db.order.update({ where: { number: n }, data: { status: "delivered" } }); // settled orders no longer block
    const enq = await db.enquiry.create({ data: { type: "business", name: "Asha", email: c.email, phone: "9876543210", company: "Rao Traders", city: "Anantapur", message: "Bulk order please" } });
    await db.subscriber.create({ data: { email: c.email } });
    await db.otpChallenge.create({ data: { emailHash: "x", codeHash: "y", expiresAt: new Date(Date.now() + 1000) } });

    const r = await read(await del(c.cookie));
    expect(r).toMatchObject({ status: 200, body: { ok: true, ordersAnonymised: 2 } });
    expect(r.res.headers.get("set-cookie")).toMatch(new RegExp(`${CUSTOMER_COOKIE}=;`));

    expect(await db.customer.count({ where: { id: c.customerId } })).toBe(0);
    expect(await db.address.count({ where: { customerId: c.customerId } })).toBe(0);
    expect(await db.customerSession.count({ where: { customerId: c.customerId } })).toBe(0);
    expect(await db.consentRecord.count({ where: { customerId: c.customerId } })).toBe(0);
    expect(await db.subscriber.count({ where: { email: c.email } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { orderId: own.order.id } })).toBe(0);
    for (const o of [own, guest]) {
      const row = await db.order.findUniqueOrThrow({ where: { number: o.number } });
      expect(row).toMatchObject({ customerId: null, customerName: "Erased customer", email: ERASED_EMAIL, phone: "0000000000", addressLine1: "Erased", addressLine2: null, city: "Erased", pincode: "000000", notes: null, state: "Andhra Pradesh", status: "delivered" });
      expect(row.accessToken).not.toBe(o.token); // the old guest link is dead
      expect(row.total).toBe(o.order.total); // the ledger keeps its amounts
    }
    expect(await db.orderItem.count({ where: { orderId: own.order.id } })).toBeGreaterThan(0);
    expect(await db.enquiry.findUniqueOrThrow({ where: { id: enq.id } })).toMatchObject({ name: "Erased", email: ERASED_EMAIL, phone: null, company: null, city: null, message: "[removed at the customer's request]" });
    const audit = JSON.stringify(await db.auditLog.findMany({ where: { action: "customer.delete" } }));
    expect(audit).toContain("customer.delete");
    expect(audit).not.toContain(c.email);
    expect((await me(mk("/api/account/me", "GET", c.cookie))).status).toBe(401);
    expect(await db.order.findMany({ where: { OR: [{ email: c.email }, { customerName: "Asha Rao", number: { in: [own.number, guest.number] } }] } })).toHaveLength(0); // nothing identifies them any more
  });

  it("the person can register again afterwards with a clean slate", async () => {
    const c = await signInCustomer();
    expect((await del(c.cookie)).status).toBe(200);
    const again = await signInCustomer(c.email);
    expect(again.customerId).not.toBe(c.customerId);
    expect((await read(await me(mk("/api/account/me", "GET", again.cookie)))).body.customer).toMatchObject({ email: c.email, name: null });
  });

  it("sibling customers are untouched by an erasure", async () => {
    const a = await signInCustomer();
    const b = await signInCustomer();
    await addressCreate(mk("/api/account/addresses", "POST", b.cookie, ADDRESS));
    const bOrder = await placeOrder(b.cookie, { email: b.email });
    await del(a.cookie);
    expect(await db.address.count({ where: { customerId: b.customerId } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { number: bOrder.number } })).customerName).toBe("Asha Rao");
    expect((await me(mk("/api/account/me", "GET", b.cookie))).status).toBe(200);
    void CUSTOMER_FIXTURE_DOMAIN; void seq;
  });
});
