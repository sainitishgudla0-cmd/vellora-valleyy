/**
 * Performance and stock-contention check against a running DISPOSABLE server (M11 P5).
 *   TEST_TARGET=disposable BASE_URL=http://127.0.0.1:3110 SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run test:perf
 * 1. Latency: each page/API below is requested sequentially (after one warm-up) and p50/p95/max are printed.
 * 2. Contention: one variant is tracked with exactly 5 units; 40 checkouts for 1 unit each arrive at once (distinct client
 *    addresses so the per-IP limiter does not hide the race). Exactly 5 must succeed, the rest 409, with no 5xx; then every
 *    order is cancelled and the variant is returned to the manual flag.
 * Exit 1 on oversell, a 5xx, or a page whose p95 exceeds PERF_P95_MS (default 2000 ms; a local, non-production number).
 */
import { assertServerIsDisposable } from "./lib/safety";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const P95_BUDGET = Number(process.env.PERF_P95_MS ?? 2000);
const RUNS = 15;
let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`  ✗ ${m}`);
};

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function time(path: string, init?: RequestInit) {
  const t = performance.now();
  const r = await fetch(`${BASE}${path}`, { ...init, redirect: "manual" });
  await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status };
}

async function admin(cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
  await assertServerIsDisposable(BASE);
  const products = (await (await fetch(`${BASE}/api/products`)).json()) as { products: { slug: string; variants: { id: string; available?: boolean }[] }[] };
  const slug = products.products[0].slug;

  console.log(`[perf] latency (${RUNS} sequential requests each, after a warm-up; budget p95 ≤ ${P95_BUDGET} ms)`);
  for (const path of ["/", "/shop", `/product/${slug}`, "/checkout", "/api/products", `/api/products/${slug}`, "/api/shipping/quote?pincode=515002&subtotal=50000", "/api/health"]) {
    await time(path);
    const xs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await time(path, { headers: { "x-forwarded-for": `198.51.100.${(i % 200) + 1}` } });
      if (r.status >= 500) fail(`${path} answered ${r.status}`);
      xs.push(r.ms);
    }
    const p95 = pct(xs, 95);
    console.log(`  ${path.padEnd(52)} p50 ${pct(xs, 50).toFixed(0).padStart(5)} ms  p95 ${p95.toFixed(0).padStart(5)} ms  max ${Math.max(...xs).toFixed(0).padStart(5)} ms`);
    if (p95 > P95_BUDGET) fail(`${path} p95 ${p95.toFixed(0)} ms over budget`);
  }

  const email = process.env.SMOKE_ADMIN_EMAIL;
  const password = process.env.SMOKE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("[perf] contention check skipped (SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD not set)");
  } else {
    const login = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password }) });
    if (!login.ok) throw new Error(`owner login failed (${login.status})`);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const variantId = products.products.at(-1)!.variants.at(-1)!.id;
    await admin(cookie, "PATCH", `/api/admin/variants/${variantId}`, { trackInventory: true, reason: "perf contention check", stockAdjust: { delta: 5, reason: "perf contention check" } });
    const N = 40;
    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const t = performance.now();
        const r = await fetch(`${BASE}/api/orders`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i + 1}` },
          body: JSON.stringify({ customerName: "SMOKE TEST Perf", email: `smoke.perf-${i}@example.com`, phone: "9876543210", addressLine1: "1 Test Street", addressLine2: "", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002", notes: "", paymentMethod: "cod", items: [{ variantId, quantity: 1 }] }),
        });
        const body = (await r.json().catch(() => ({}))) as { order?: { number: string } };
        return { status: r.status, ms: performance.now() - t, number: body.order?.number };
      }),
    );
    const wall = performance.now() - t0;
    const ok = results.filter((r) => r.status === 201);
    const conflict = results.filter((r) => r.status === 409);
    const server = results.filter((r) => r.status >= 500);
    console.log(`[perf] contention: ${N} simultaneous checkouts for 5 units -> ${ok.length} placed, ${conflict.length} refused (409), ${server.length} errors; wall ${wall.toFixed(0)} ms, p95 ${pct(results.map((r) => r.ms), 95).toFixed(0)} ms`);
    if (ok.length !== 5) fail(`expected exactly 5 orders, got ${ok.length} (oversell or lost sale)`);
    if (server.length) fail(`${server.length} server errors under contention`);
    const v = (await admin(cookie, "GET", `/api/admin/variants/low-stock?threshold=10000`)) as { variants: { variantId: string; stockQuantity: number; reserved: number }[] };
    const row = v.variants.find((x) => x.variantId === variantId);
    if (!row || row.reserved !== 5 || row.stockQuantity !== 5) fail(`ledger after contention: ${JSON.stringify(row)}`);
    // clean up: cancel every placed order (releases holds), then back to the manual flag
    for (const o of ok) {
      const id = await findOrderId(cookie, o.number!);
      if (id) await admin(cookie, "PATCH", `/api/admin/orders/${id}`, { status: "cancelled", reason: "perf check cleanup" });
    }
    await admin(cookie, "PATCH", `/api/admin/variants/${variantId}`, { trackInventory: false, reason: "perf check cleanup" });
    await admin(cookie, "PATCH", `/api/admin/variants/${variantId}`, { inStock: true });
  }
  console.log(failures ? `[perf] ✗ ${failures} problem(s)` : "[perf] ✓ no oversell, no server errors, all pages within budget");
  process.exit(failures ? 1 : 0);
}

/** The admin dashboard is HTML; the order id comes from the order page link. */
async function findOrderId(cookie: string, number: string): Promise<string | null> {
  const html = await (await fetch(`${BASE}/admin?tab=orders`, { headers: { cookie } })).text();
  const m = new RegExp(`/admin/orders/([a-z0-9]+)"[^>]*>${number}<`).exec(html);
  return m ? m[1] : null;
}

main().catch((e) => {
  console.error(`[perf] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
