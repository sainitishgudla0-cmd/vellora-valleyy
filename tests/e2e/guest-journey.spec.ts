/**
 * Guest journey (ported from the old scripts/e2e-ui.mjs, M8-T5) plus the integration of M2-M7: checkout messages, live delivery quote,
 * order tracking and invoice download on the order page. One serial flow: the cart and the placed order carry over between steps.
 */
import { expect, test, type Page } from "@playwright/test";
import { must, adminApi, BASE, closeDb, db, ensureIllustrativeTaxRates, hasOwner } from "./support/env";
import { DESKTOP, newContext, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });

let page: Page;
let errors: ReturnType<typeof watchErrors>;
let orderUrl = "";

test.beforeAll(async ({ browser }) => {
  const ctx = await newContext(browser, DESKTOP);
  page = await ctx.newPage();
  errors = watchErrors(page, "guest");
});
test.afterAll(async () => {
  await page.context().close();
  await closeDb();
});

const cartBadge = () => page.locator('header button[aria-label^="Open cart"]').first().getAttribute("aria-label");

test("navigation menus open", async () => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.hover("header nav >> text=Dates");
  await expect(page.getByText("All Dates").first()).toBeVisible();
  await page.hover("header nav >> text=Shop");
  await expect(page.getByText("Shop all").first()).toBeVisible();
  await page.mouse.move(700, 600);
  await page.keyboard.press("Escape");
});

test("shop search, filters and empty state", async () => {
  await page.goto("/shop", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const total = await page.locator("main article").count();
  expect(total, "shop lists all products").toBeGreaterThanOrEqual(30);
  await page.fill("#shop-search", "dates");
  await page.waitForTimeout(900);
  const datesCount = await page.locator("main article").count();
  expect(datesCount).toBeGreaterThan(0);
  expect(datesCount).toBeLessThan(total);
  expect(page.url()).toContain("q=dates");
  await page.fill("#shop-search", "");
  await page.locator('aside label:has-text("Seeds")').click();
  await page.waitForTimeout(900);
  expect(await page.locator("main article").count()).toBe(8);
  expect(page.url()).toContain("category=seeds");
  await page.selectOption("#shop-sort", "price-desc");
  await page.goto("/shop?q=zzzz", { waitUntil: "networkidle" });
  await expect(page.getByText("Nothing found")).toBeVisible();
});

test("quick view and add to cart", async () => {
  await page.goto("/shop?category=nuts", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const card = page.locator("main article").first();
  await card.hover();
  await card.locator('button:has-text("Quick view")').click();
  await expect(page.locator('[role=dialog][aria-label$="quick view"]')).toBeVisible();
  await page.locator('[role=dialog] button:has-text("Add to cart")').click();
  await expect(page.getByText("added to your cart").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[role=dialog][aria-label$="quick view"]')).toBeHidden();
  expect(await cartBadge()).toMatch(/1 item/);
});

test("product page: variant, quantity and the cart drawer", async () => {
  await page.goto("/product/kimia-dates", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.locator('label:has-text("400g")').click();
  await expect(page.getByText("₹350").first()).toBeVisible();
  await page.click('button[aria-label="Increase quantity"]');
  await page.locator('main button:has-text("Add to cart")').first().click();
  const drawer = page.locator('[role=dialog][aria-label="Your cart"]');
  await expect(drawer).toBeVisible();
  const text = (await drawer.innerText()).toLowerCase();
  expect(text).toContain("kimia dates");
  expect(text).toContain("400g");
  await page.keyboard.press("Escape");
});

test("the cart persists across navigation", async () => {
  await page.goto("/cart", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  expect(await page.locator('main li:has(button[aria-label^="Remove"])').count()).toBeGreaterThanOrEqual(2);
});

test("checkout: validation, then a guest order request", async () => {
  await page.goto("/checkout", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.click("button[type=submit]");
  await page.waitForTimeout(400);
  expect(await page.locator(".field-error").count(), "validation errors").toBeGreaterThanOrEqual(5);
  await page.fill("#f-customerName", "SMOKE TEST UI");
  await page.fill("#f-phone", "9876500000");
  await page.fill("#f-email", "smoke.ui@example.com");
  await page.fill("#f-addressLine1", "4 UI Test Road");
  await page.fill("#f-city", "Anantapur");
  await page.fill("#f-pincode", "515002");
  await page.selectOption("#f-state", "Andhra Pradesh");
  await page.fill("#f-notes", "SMOKE TEST — please ignore");
  await expect(page.locator("input[name=payment]").nth(1), "online payment disabled when not configured").toBeDisabled();
  await expect(page.getByText("To be confirmed").first()).toBeVisible(); // no shipping rules yet: legacy wording is unchanged
  await page.click("button[type=submit]");
  await page.waitForURL(/\/order\//, { timeout: 15_000 });
  expect(page.url()).toMatch(/\/order\/VV-/);
  orderUrl = page.url();
  await expect(page.getByText("No payment has been taken")).toBeVisible();
  expect(await cartBadge()).toMatch(/0 items/);
  await expect(page.getByTestId("shipment")).toHaveCount(0); // nothing shipped, nothing invoiced yet
  await expect(page.getByTestId("invoice-link")).toHaveCount(0);
});

test("business enquiry page: interest preselected and validation", async () => {
  await page.goto("/business?interest=export", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  expect(await page.locator("input[name=interest]").nth(4).isChecked()).toBe(true);
  await page.click("form button[type=submit]");
  await page.waitForTimeout(300);
  expect(await page.locator(".field-error").count()).toBeGreaterThanOrEqual(3);
});

test("the order page shows tracking and the invoice once staff add them", async () => {
  test.skip(!hasOwner(), "needs the owner account created by verify:full");
  const number = new URL(orderUrl).pathname.split("/").pop()!;
  const token = new URL(orderUrl).searchParams.get("t")!;
  const order = await db().order.findUniqueOrThrow({ where: { number } });
  const admin = await adminApi();
  try {
    await ensureIllustrativeTaxRates(admin);
    await must(await admin.patch(`/api/admin/orders/${order.id}`, { data: { status: "confirmed", reason: "e2e" } }));
    const awb = `E2E${Date.now()}`;
    const ship = await admin.post(`/api/admin/orders/${order.id}/shipments`, { data: { courier: "Delhivery", awb, trackingUrl: "https://track.example.com/e2e" } });
    expect(ship.status()).toBe(201);
    const inv = await admin.post(`/api/admin/orders/${order.id}/invoice`);
    expect(inv.status(), await inv.text()).toBe(201);
    const invoiceNumber = (await inv.json()).invoice.number as string;

    await page.goto(orderUrl, { waitUntil: "networkidle" });
    await expect(page.getByText("Status: Confirmed")).toBeVisible();
    await expect(page.getByTestId("shipment")).toContainText(awb);
    await expect(page.getByTestId("shipment")).toContainText("Shipment created");
    const link = page.getByTestId("invoice-link");
    await expect(link).toContainText(invoiceNumber);
    const pdf = await page.request.get((await link.getAttribute("href"))!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    // someone without the token gets nothing
    expect((await page.request.get(`/api/orders/${number}/invoice?t=wrong`)).status()).toBe(404);
    expect((await page.request.get(`/api/orders/${number}/invoice?t=${token}`)).status()).toBe(200);
    // tracking moves along
    const sid = (await db().shipment.findFirstOrThrow({ where: { awb } })).id;
    await admin.patch(`/api/admin/shipments/${sid}`, { data: { status: "picked_up" } });
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("shipment")).toContainText("Picked up");
  } finally {
    await admin.dispose();
  }
});

test("checkout shows the delivery fee for the pincode, and refuses an unserviceable one next to the field", async () => {
  test.skip(!hasOwner(), "needs the owner account created by verify:full");
  const admin = await adminApi();
  const created: string[] = [];
  try {
    for (const rule of [
      { name: "e2e all", pincodePrefix: "", fee: 9900 },
      { name: "e2e anantapur", pincodePrefix: "515", fee: 2500, freeAboveSubtotal: 5_000_000 },
      { name: "e2e island", pincodePrefix: "682", serviceable: false },
    ]) {
      const r = await admin.post("/api/admin/shipping-rules", { data: rule });
      expect(r.status()).toBe(201);
      created.push((await r.json()).rule.id);
    }
    // add something to the cart again
    await page.goto("/product/premium-cashews", { waitUntil: "networkidle" });
    await page.locator('main button:has-text("Add to cart")').first().click();
    await page.keyboard.press("Escape");
    await page.goto("/checkout", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const delivery = page.locator("dl >> div", { hasText: "Delivery" }).first();
    await page.fill("#f-pincode", "515002");
    await expect(delivery).toContainText("₹25");
    await page.fill("#f-pincode", "110001");
    await expect(delivery).toContainText("₹99");
    await page.fill("#f-pincode", "682001");
    await expect(page.locator("#e-pincode")).toContainText("We do not deliver to this pincode yet");
    await expect(delivery).toContainText("Not available");
    await expect(page.locator("button[type=submit]").first()).toBeDisabled();
    await page.fill("#f-pincode", "515002");
    await expect(page.locator("#e-pincode")).toHaveCount(0);
    await expect(page.locator("button[type=submit]").first()).toBeEnabled();
  } finally {
    for (const id of created) await admin.delete(`/api/admin/shipping-rules/${id}`);
    await admin.dispose();
  }
});

test("checkout says something useful when the order cannot be placed", async () => {
  await page.goto("/checkout", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  for (const [sel, val] of [["#f-customerName", "SMOKE TEST UI"], ["#f-phone", "9876500000"], ["#f-email", "smoke.ui@example.com"], ["#f-addressLine1", "4 UI Test Road"], ["#f-city", "Anantapur"], ["#f-pincode", "515002"]] as const) await page.fill(sel, val);
  await page.selectOption("#f-state", "Andhra Pradesh");
  // the server is down / unreachable
  await page.route("**/api/orders", (route) => route.abort("failed"));
  await page.click("button[type=submit]");
  await expect(page.locator("p[role=alert]")).toContainText("could not reach the store");
  await page.unroute("**/api/orders");
  // a proxy error page that is not JSON
  await page.route("**/api/orders", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }));
  await page.click("button[type=submit]");
  await expect(page.locator("p[role=alert]")).toContainText("Nothing has been charged");
  await page.unroute("**/api/orders");
  // too many attempts and an out-of-stock refusal use the server's own words
  await page.route("**/api/orders", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Premium Cashews (250g) is out of stock." }) }));
  await page.click("button[type=submit]");
  await expect(page.locator("p[role=alert]")).toContainText("Premium Cashews (250g) is out of stock.");
  await page.unroute("**/api/orders");
  // a double submit of the same order sends the same Idempotency-Key
  const keys: string[] = [];
  await page.route("**/api/orders", (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.click("button[type=submit]");
  await expect(page.locator("p[role=alert]")).toContainText("Nothing has been charged");
  await page.click("button[type=submit]");
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]); // the same request keeps its key, so a retry can never create a second order
  await page.fill("#f-notes", "changed");
  await page.click("button[type=submit]");
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[0]); // a different request gets a new key
  await page.unroute("**/api/orders");
});

test("no unexpected browser errors", () => {
  errors.expectClean();
});

test("base URL is a disposable server (guard)", () => {
  expect(BASE).toMatch(/127\.0\.0\.1|localhost/);
});
