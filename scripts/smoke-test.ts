/**
 * End-to-end API smoke test against a running server.
 *   BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... npm run test:api
 * Creates one test order + enquiries in the database (marked "SMOKE TEST").
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
let passed = 0;
let failed = 0;

function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

async function req(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    redirect: "manual",
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, body, headers: res.headers };
}

const customer = {
  customerName: "SMOKE TEST Customer",
  email: "smoke.test@example.com",
  phone: "9876543210",
  addressLine1: "12 Test Street, Test Nagar",
  addressLine2: "",
  city: "Anantapur",
  state: "Andhra Pradesh",
  pincode: "515002",
  notes: "SMOKE TEST — please ignore",
};

async function main() {
  console.log(`Smoke testing ${BASE}\n`);

  console.log("Catalogue");
  const all = await req("/api/products");
  check("GET /api/products returns products", all.status === 200 && all.body.count >= 30, all.body.count);
  const search = await req("/api/products?q=cashew");
  check("search ?q=cashew finds Premium Cashews", search.body.products?.some((p: any) => p.slug === "premium-cashews"));
  const dates = await req("/api/products?category=dates");
  check("category filter returns only dates", dates.body.count > 0 && dates.body.products.every((p: any) => p.categories.includes("dates")));
  const multi = await req("/api/products?category=nuts,seeds");
  check("multi-category filter (nuts,seeds)", multi.body.products.some((p: any) => p.categories.includes("nuts")) && multi.body.products.some((p: any) => p.categories.includes("seeds")));
  const cheap = await req("/api/products?max=60&sort=price-asc");
  check("max price + sort", cheap.body.products.every((p: any) => p.variants.some((v: any) => v.price <= 6000)));
  const one = await req("/api/products/kimia-dates");
  check("GET product detail with 3 variants", one.status === 200 && one.body.product.variants.length === 3);
  check("unknown product 404", (await req("/api/products/not-a-product")).status === 404);

  const cashews = all.body.products.find((p: any) => p.slug === "premium-cashews");
  const kimia = one.body.product;
  const v1 = cashews.variants[0];
  const v2 = kimia.variants[1];

  console.log("\nCart");
  const val = await req("/api/cart/validate", { method: "POST", json: { variantIds: [v1.id, v2.id, "missing"] } });
  check("cart validate returns server prices", val.status === 200 && val.body.variants.length === 2 && val.body.variants[0].price > 0);

  console.log("\nCheckout validation");
  const bad = await req("/api/orders", { method: "POST", json: { ...customer, phone: "123", pincode: "12", email: "nope", paymentMethod: "cod", items: [{ variantId: v1.id, quantity: 1 }] } });
  check("invalid fields rejected with 422", bad.status === 422 && bad.body.fields?.phone && bad.body.fields?.pincode && bad.body.fields?.email, bad.body);
  const empty = await req("/api/orders", { method: "POST", json: { ...customer, paymentMethod: "cod", items: [] } });
  check("empty cart rejected", empty.status === 422);
  const ghost = await req("/api/orders", { method: "POST", json: { ...customer, paymentMethod: "cod", items: [{ variantId: "does-not-exist", quantity: 1 }] } });
  check("unknown variant rejected (409)", ghost.status === 409);
  const online = await req("/api/orders", { method: "POST", json: { ...customer, paymentMethod: "razorpay", items: [{ variantId: v1.id, quantity: 1 }] } });
  const onlineConfigured = !!process.env.RAZORPAY_KEY_ID;
  if (!onlineConfigured) check("online payment refused when Razorpay is not configured", online.status === 400, online.body);

  console.log("\nOrder (pay on delivery)");
  const order = await req("/api/orders", {
    method: "POST",
    json: { ...customer, paymentMethod: "cod", items: [{ variantId: v1.id, quantity: 2 }, { variantId: v2.id, quantity: 1 }, { variantId: v1.id, quantity: 1 }] },
  });
  check("order created (201)", order.status === 201, order.body);
  const expected = v1.price * 3 + v2.price;
  check("total recomputed on server, duplicates merged", order.body.order?.total === expected, { got: order.body.order?.total, expected });
  const { number, token } = order.body.order ?? {};
  const page = await req(`/order/${number}?t=${encodeURIComponent(token)}`);
  check("confirmation page loads with token", page.status === 200 && String(page.body).includes(number));
  check("confirmation page says awaiting confirmation, no payment taken", String(page.body).includes("No payment has been taken"));
  const noTok = await req(`/order/${number}`);
  check("order page hidden without token (404)", noTok.status === 404);
  const wrongTok = await req(`/order/${number}?t=wrong`);
  check("order page hidden with wrong token (404)", wrongTok.status === 404);

  console.log("\nPayment verification");
  const fake = await req("/api/payments/razorpay/verify", {
    method: "POST",
    json: { orderNumber: number, token, razorpay_order_id: "order_fake", razorpay_payment_id: "pay_fake", razorpay_signature: "deadbeef" },
  });
  check("forged payment confirmation rejected", fake.status === 404 || fake.status === 400, fake.status);

  console.log("\nEnquiries & newsletter");
  const eBad = await req("/api/enquiries", { method: "POST", json: { type: "business", name: "X", email: "bad", message: "short" } });
  check("enquiry validation errors", eBad.status === 422 && eBad.body.fields?.interest && eBad.body.fields?.email && eBad.body.fields?.phone, eBad.body);
  const eOk = await req("/api/enquiries", {
    method: "POST",
    json: { type: "business", name: "SMOKE TEST Distributor", email: "smoke.biz@example.com", phone: "+91 98765 43210", company: "Test Traders", city: "Kurnool", interest: "distributor", message: "SMOKE TEST — distributor enquiry, please ignore." },
  });
  check("business enquiry stored", eOk.status === 201 && eOk.body.id);
  const cOk = await req("/api/enquiries", { method: "POST", json: { type: "contact", name: "SMOKE TEST", email: "smoke.contact@example.com", message: "SMOKE TEST — contact message, please ignore." } });
  check("contact enquiry stored", cOk.status === 201);
  const nl = await req("/api/newsletter", { method: "POST", json: { email: "smoke.newsletter@example.com" } });
  const nl2 = await req("/api/newsletter", { method: "POST", json: { email: "smoke.newsletter@example.com" } });
  check("newsletter subscribe is idempotent", nl.status === 201 && nl2.status === 201);
  check("newsletter rejects bad email", (await req("/api/newsletter", { method: "POST", json: { email: "x" } })).status === 422);

  console.log("\nAdmin");
  check("admin PATCH without session → 401", (await req(`/api/admin/variants/${v1.id}`, { method: "PATCH", json: { price: 1 } })).status === 401);
  check("admin wrong password → 401", (await req("/api/admin/login", { method: "POST", json: { password: "wrong-password" } })).status === 401);
  if (process.env.ADMIN_PASSWORD) {
    const login = await req("/api/admin/login", { method: "POST", json: { password: process.env.ADMIN_PASSWORD } });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    check("admin login sets session cookie", login.status === 200 && cookie.startsWith("vv_admin="));
    const original = v1.price / 100;
    const upd = await req(`/api/admin/variants/${v1.id}`, { method: "PATCH", json: { price: original + 1 }, headers: { cookie } });
    const after = await req("/api/products/premium-cashews");
    check("admin price edit reflected in catalogue", upd.status === 200 && after.body.product.variants[0].price === (original + 1) * 100);
    await req(`/api/admin/variants/${v1.id}`, { method: "PATCH", json: { price: original }, headers: { cookie } });
    const ord = await req("/admin?tab=orders", { headers: { cookie } });
    check("admin dashboard lists the test order", ord.status === 200 && String(ord.body).includes(number));
  } else {
    console.log("  (skipping authenticated admin checks — ADMIN_PASSWORD not set)");
  }

  console.log("\nPages");
  for (const p of ["/", "/shop", "/shop?category=dates", "/product/safawi-dates", "/cart", "/checkout", "/our-story", "/quality", "/contact", "/business", "/admin"]) {
    const r = await req(p);
    check(`GET ${p} → 200`, r.status === 200, r.status);
  }
  check("unknown page → 404", (await req("/definitely-missing")).status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
