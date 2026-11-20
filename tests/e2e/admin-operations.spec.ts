/**
 * M11 P4 admin operations through the UI: the order page (manual pay-on-delivery collection, shipment, tracking status,
 * tax invoice, history), stock tracking on the products tab, the operations tab (readiness, exceptions) and settings
 * (shipping rule add/remove). Every action goes through the real audited API. Leaves the shared database as it found it.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { adminApi, BASE, closeDb, db, ensureIllustrativeTaxRates, hasOwner, must, stamp } from "./support/env";
import { DESKTOP, newContext, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });
test.skip(!hasOwner(), "needs the throwaway owner account that verify:full creates");

let ctx: BrowserContext;
let page: Page;
let orderId = "";
let orderNumber = "";

test.beforeAll(async ({ browser }) => {
  const admin = await adminApi();
  try {
    // a variant whose HSN code has an (illustrative) GST rate, so the invoice can be issued
    const v = await db().variant.findFirstOrThrow({ where: { product: { active: true }, inStock: true, trackInventory: false, hsCode: { in: ["08013220", "080212", "08025200", "08041020", "08062010", "18069090"] } }, orderBy: { sku: "asc" } });
    const res = await must(
      await admin.post("/api/orders", {
        data: { customerName: "SMOKE TEST Admin Ops", email: `smoke.adminops-${stamp()}@example.com`, phone: "9876543210", addressLine1: "1 Test Street", addressLine2: "", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002", notes: "", paymentMethod: "cod", items: [{ variantId: v.id, quantity: 1 }] },
      }),
    );
    orderNumber = (await res.json()).order.number;
    orderId = (await db().order.findUniqueOrThrow({ where: { number: orderNumber } })).id;
    await must(await admin.patch(`/api/admin/orders/${orderId}`, { data: { status: "confirmed", reason: "e2e admin ops" } }));
    await ensureIllustrativeTaxRates(admin);
  } finally {
    await admin.dispose();
  }
  ctx = await newContext(browser, DESKTOP);
  // reuse the owner session the API helper cached (the login limiter is shared by every spec)
  const fs = await import("node:fs");
  const [name, value] = fs.readFileSync("test-results/.owner-cookie", "utf8").split("=");
  await ctx.addCookies([{ name, value, url: BASE }]);
  page = await ctx.newPage();
});
test.afterAll(async () => {
  await ctx?.close();
  await closeDb();
});

test("order page: record a pay-on-delivery collection, add and move a shipment, issue the invoice; history shows each step", async () => {
  const errors = watchErrors(page, "admin-order");
  await page.goto("/admin?tab=orders");
  await page.getByRole("link", { name: orderNumber }).click();
  await expect(page.getByTestId("admin-order-number")).toHaveText(orderNumber);
  await expect(page.getByTestId("order-history")).toContainText("confirmed");

  const ref = `RCPT-E2E-${stamp()}`;
  page.once("dialog", (d) => d.accept()); // "this record cannot be changed later"
  const total = (await db().order.findUniqueOrThrow({ where: { id: orderId } })).total;
  await page.getByLabel(/Amount received/).fill((total / 100).toFixed(2));
  await page.getByLabel("Method").selectOption("upi");
  await page.getByLabel("Receipt / UTR / reference").fill(ref);
  await page.getByLabel("How it was collected").fill("Cash on delivery collected by courier");
  await page.getByRole("button", { name: "Record payment received" }).click();
  await expect(page.getByTestId("order-history")).toContainText(`ref ${ref}`);
  await expect(page.getByTestId("manual-payment-form")).toHaveCount(0); // nothing left to collect

  const awb = `E2E${stamp()}`.toUpperCase().slice(0, 20);
  await page.getByLabel("Courier").fill("DTDC");
  await page.getByLabel("AWB / tracking number").fill(awb);
  await page.getByRole("button", { name: "Add shipment" }).click();
  await expect(page.getByTestId("shipment-row")).toContainText(awb);
  await page.getByLabel("Shipment status").selectOption("picked_up");
  await expect(page.getByTestId("shipment-row")).toContainText(/picked up/);

  await page.getByRole("button", { name: "Issue tax invoice" }).click();
  await expect(page.getByTestId("invoice-issued")).toBeVisible();
  const o = await db().order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, invoice: true, shipments: true } });
  expect(o.paymentStatus).toBe("paid");
  expect(o.payments[0]).toMatchObject({ manualReference: ref, manualMethod: "upi" });
  expect(o.invoice).not.toBeNull();
  expect(o.shipments[0]).toMatchObject({ awb, status: "picked_up" });
  const audit = await db().auditLog.findMany({ where: { targetId: orderId, action: { in: ["order.update", "shipment.create", "invoice.issue"] }, outcome: "success" } });
  expect(audit.map((a) => a.action).sort()).toEqual(["invoice.issue", "order.update", "order.update", "shipment.create"].sort());
  errors.expectClean();
});

test("cancelling a paid order from the status menu asks for the reason and records it", async () => {
  const admin = await adminApi();
  let id = "";
  try {
    const v = await db().variant.findFirstOrThrow({ where: { product: { active: true }, inStock: true, trackInventory: false }, orderBy: { sku: "asc" } });
    const res = await must(await admin.post("/api/orders", { data: { customerName: "SMOKE TEST Admin Ops", email: `smoke.adminops-${stamp()}@example.com`, phone: "9876543210", addressLine1: "1 Test Street", addressLine2: "", city: "Anantapur", state: "Andhra Pradesh", pincode: "515002", notes: "", paymentMethod: "cod", items: [{ variantId: v.id, quantity: 1 }] } }));
    id = (await db().order.findUniqueOrThrow({ where: { number: (await res.json()).order.number } })).id;
    await must(await admin.patch(`/api/admin/orders/${id}`, { data: { status: "confirmed", reason: "e2e" } }));
    await must(await admin.patch(`/api/admin/orders/${id}`, { data: { paymentStatus: "paid", reason: "cash", paymentReference: `RCPT-CXL-${stamp()}`, offline: { amountPaise: (await db().order.findUniqueOrThrow({ where: { id } })).total, method: "cash" } } }));
  } finally {
    await admin.dispose();
  }
  const reason = "Customer cancelled; cash returned at the door";
  const onDialog = (d: import("@playwright/test").Dialog) => (d.type() === "prompt" ? d.accept(reason) : d.dismiss());
  page.on("dialog", onDialog);
  await page.goto(`/admin/orders/${id}`);
  await page.getByLabel("Order status").selectOption("cancelled");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  page.off("dialog", onDialog);
  await page.reload();
  await expect(page.getByTestId("order-history")).toContainText(reason);
  expect((await db().order.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
});

test("products: start tracking a variant with counted stock, then adjust it", async () => {
  const v = await db().variant.findFirstOrThrow({ where: { product: { active: true }, trackInventory: false }, orderBy: { sku: "desc" } });
  await page.goto("/admin?tab=products");
  const row = page.locator("tr", { has: page.getByText(v.sku, { exact: true }) });
  await row.getByLabel("Opening stock").fill("12");
  await row.getByLabel("Reason").fill("e2e opening count");
  await row.getByRole("button", { name: "Start tracking" }).click();
  await expect(row.getByTestId("stock-summary")).toContainText("12 available");
  await row.getByLabel("Change in units (+/-)").fill("-2");
  await row.getByLabel("Reason").fill("e2e damaged");
  await row.getByRole("button", { name: "Adjust" }).click();
  await expect(row.getByTestId("stock-summary")).toContainText("10 available");
  // leave the catalogue as other specs expect it: back to the manual flag
  const admin = await adminApi();
  try {
    await must(await admin.patch(`/api/admin/variants/${v.id}`, { data: { trackInventory: false, reason: "e2e cleanup" } }));
    await must(await admin.patch(`/api/admin/variants/${v.id}`, { data: { inStock: true } }));
  } finally {
    await admin.dispose();
  }
});

test("operations tab: readiness checks and the payments-needing-a-person section render", async () => {
  await page.goto("/admin?tab=operations");
  const items = page.getByTestId("readiness-list").locator("li");
  expect(await items.count()).toBeGreaterThan(10);
  await expect(page.getByTestId("readiness-list").locator('li[data-status="ok"]').first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payments needing a person" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Low stock" })).toBeVisible();
});

test("settings tab: add a shipping rule, see it, then delete it (serviceability is restored)", async () => {
  page.on("dialog", (d) => d.accept());
  await page.goto("/admin?tab=settings");
  const name = `e2e rule ${stamp()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Pincode prefix (empty = all)").fill("5");
  await page.getByLabel("Fee ₹").fill("40");
  await page.getByRole("button", { name: "Add rule" }).click();
  const row = page.locator("tr", { hasText: name });
  await expect(row).toContainText("₹40");
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
  expect(await db().shippingRule.count({ where: { name } })).toBe(0);
});
