/** Signed-in shopper journey (M5 + M7 integration, M8-T2): sign-in with an emailed code, addresses, claiming a guest order, order detail with invoice, privacy, deletion. */
import { expect, test, type Page } from "@playwright/test";
import { must, adminApi, closeDb, db, ensureIllustrativeTaxRates, hasOwner, otpCode, signInThroughUi, stamp } from "./support/env";
import { browserFetch, DESKTOP, newContext, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });
test.skip(!hasOwner(), "needs the owner account created by verify:full (UI_TEST_ADMIN_*)");

const email = `smoke.shopper-${stamp()}@example.com`;
let page: Page;
let errors: ReturnType<typeof watchErrors>;
let guestOrderNumber = "";

test.beforeAll(async ({ browser }) => {
  const ctx = await newContext(browser, DESKTOP);
  page = await ctx.newPage();
  errors = watchErrors(page, "account");
});
test.afterAll(async () => {
  await page.context().close();
  await closeDb();
});

test("sign-in: a wrong code is refused, a new address must accept the terms, then the dashboard opens", async () => {
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await page.fill("#acct-email", email);
  await page.click('button:has-text("Email me a code")');
  await expect(page.getByRole("form", { name: "Sign in" }).getByRole("status")).toContainText("6-digit code is on its way");
  await page.fill("#acct-code", "000000");
  await page.click('button:has-text("Sign in")');
  await expect(page.locator(".field-error")).toContainText("incorrect or has expired");
  await page.fill("#acct-code", await otpCode(email));
  await page.click('button:has-text("Sign in")');
  await expect(page.locator(".field-error")).toContainText("accept the terms"); // only now, after the code proved the address
  await expect(page.locator('button:has-text("Create account and sign in")')).toBeDisabled();
  await page.locator("input[type=checkbox]").first().check();
  await page.click('button:has-text("Create account and sign in")');
  await expect(page.locator('nav[aria-label="Account sections"]')).toBeVisible();
  await expect(page.locator("h1")).toContainText(email);
  await expect(page.getByText("You have no orders in your account yet.")).toBeVisible();
});

test("details and saved addresses: add, edit, default, delete", async () => {
  await page.goto("/account?tab=addresses");
  await page.fill("#pf-name", "Asha Rao");
  await page.fill("#pf-phone", "9876543210");
  await page.click('button:has-text("Save")');
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.locator("h1")).toContainText("Asha Rao");

  await page.click('button:has-text("Add an address")');
  await page.fill("#ad-label", "Home");
  await page.fill("#ad-name", "Asha Rao");
  await page.fill("#ad-phone", "9876543210");
  await page.fill("#ad-pin", "515001");
  await page.fill("#ad-line1", "12 MG Road");
  await page.fill("#ad-city", "Anantapur");
  await page.selectOption("#ad-state", "Andhra Pradesh");
  await page.click('button:has-text("Save address")');
  const cards = page.getByTestId("address");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Default"); // the first address is the default

  await page.click('button:has-text("Add an address")');
  await page.fill("#ad-label", "Office");
  await page.fill("#ad-name", "Asha Rao");
  await page.fill("#ad-phone", "9876543210");
  await page.fill("#ad-pin", "560001");
  await page.fill("#ad-line1", "7 Station Road");
  await page.fill("#ad-city", "Bengaluru");
  await page.selectOption("#ad-state", "Karnataka");
  await page.click('button:has-text("Save address")');
  await expect(cards).toHaveCount(2);

  await page.fill("#pf-name", "Asha Rao"); // (keeps the details form untouched)
  await cards.filter({ hasText: "Office" }).getByRole("button", { name: "Make default" }).click();
  await expect(cards.filter({ hasText: "Office" })).toContainText("Default");
  await expect(cards.filter({ hasText: "Home" })).not.toContainText("Default");

  await cards.filter({ hasText: "Office" }).getByRole("button", { name: "Edit" }).click();
  await page.fill("#ad-label", "Work");
  await page.click('button:has-text("Save address")');
  await expect(cards.filter({ hasText: "Work" })).toHaveCount(1);

  page.once("dialog", (d) => d.accept());
  await cards.filter({ hasText: "Home" }).getByRole("button", { name: "Delete" }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Default"); // still exactly one default
});

test("an earlier guest order can be claimed by the verified email, and then opened", async () => {
  const variant = await db().variant.findFirstOrThrow({ where: { inStock: true, trackInventory: false, product: { active: true } } });
  const res = await page.request.post("/api/orders", {
    data: { customerName: "SMOKE TEST Shopper", email, phone: "9876543210", addressLine1: "12 MG Road", city: "Anantapur", state: "Andhra Pradesh", pincode: "515001", paymentMethod: "cod", items: [{ variantId: variant.id, quantity: 2 }] },
  });
  expect(res.status()).toBe(201);
  guestOrderNumber = (await res.json()).order.number;
  await page.goto("/account");
  await expect(page.getByTestId("order-row")).toHaveCount(0); // a guest order is not visible until claimed
  await page.click('button:has-text("Find my earlier orders")');
  await expect(page.getByText("Added 1 order(s) to your account.")).toBeVisible();
  await expect(page.getByTestId("order-row")).toHaveCount(1);
  await page.getByRole("link", { name: guestOrderNumber }).click();
  await expect(page.locator("h1")).toContainText(guestOrderNumber);
  await expect(page.getByTestId("order-status")).toContainText("awaiting confirmation");
  await expect(page.getByTestId("invoice-download")).toHaveCount(0);
});

test("staff confirm, ship and invoice it: the order page shows tracking and downloads the invoice", async () => {
  const order = await db().order.findUniqueOrThrow({ where: { number: guestOrderNumber } });
  const admin = await adminApi();
  try {
    await ensureIllustrativeTaxRates(admin);
    await must(await admin.patch(`/api/admin/orders/${order.id}`, { data: { status: "confirmed", reason: "e2e" } }));
    const awb = `ACC${Date.now()}`;
    expect((await admin.post(`/api/admin/orders/${order.id}/shipments`, { data: { courier: "DTDC", awb } })).status()).toBe(201);
    const inv = await admin.post(`/api/admin/orders/${order.id}/invoice`);
    expect(inv.status(), await inv.text()).toBe(201);
    await page.goto(`/account/orders/${guestOrderNumber}`);
    await expect(page.getByTestId("order-status")).toContainText("Confirmed");
    await expect(page.getByTestId("shipment")).toContainText(awb);
    const href = await page.getByTestId("invoice-download").getAttribute("href");
    const pdf = await browserFetch(page, href!);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } finally {
    await admin.dispose();
  }
  // someone else's order number is just "not found"
  const other = await db().order.findFirst({ where: { customerId: null, number: { not: guestOrderNumber } } });
  if (other) {
    const r = await page.goto(`/account/orders/${other.number}`);
    expect(r?.status()).toBe(404);
  }
});

test("privacy: consent, data download, and deletion that waits for open orders", async () => {
  await page.goto("/account?tab=privacy");
  await page.getByLabel("Send me news and offers by email").check();
  await expect.poll(async () => (await db().customer.findUniqueOrThrow({ where: { email } })).marketingConsent).toBe(true);
  await page.getByLabel("Send me news and offers by email").uncheck();
  await expect.poll(async () => (await db().customer.findUniqueOrThrow({ where: { email } })).marketingConsent).toBe(false);

  const exp = await browserFetch(page, "/api/account/export");
  expect(exp.status).toBe(200);
  expect(exp.headers["content-disposition"]).toContain("attachment");
  const data = exp.json();
  expect(data.customer.email).toBe(email);
  expect(data.orders.map((o: { number: string }) => o.number)).toContain(guestOrderNumber);
  expect(JSON.stringify(data)).not.toMatch(/accessToken|tokenHash/);

  const del = page.getByRole("button", { name: "Delete my account" });
  await expect(del).toBeDisabled();
  await page.fill("#del-confirm", "DELETE");
  await del.click();
  await expect(page.locator("p[role=alert]")).toContainText("orders in progress"); // the confirmed order is still open

  const order = await db().order.findUniqueOrThrow({ where: { number: guestOrderNumber } });
  const admin = await adminApi();
  try {
    for (const status of ["dispatched", "delivered"]) await must(await admin.patch(`/api/admin/orders/${order.id}`, { data: { status } }));
  } finally {
    await admin.dispose();
  }
  await del.click();
  await expect(page.locator("#acct-email")).toBeVisible(); // signed out
  expect(await db().customer.count({ where: { email } })).toBe(0);
  const anonymised = await db().order.findUniqueOrThrow({ where: { number: guestOrderNumber } });
  expect(anonymised).toMatchObject({ customerName: "Erased customer", email: "erased@erased.invalid", status: "delivered" });
  errors.expectClean();
});

test("sign out ends the session on the server", async ({ browser }) => {
  const e2 = `smoke.signout-${stamp()}@example.com`;
  const ctx = await newContext(browser, DESKTOP);
  const p = await ctx.newPage();
  await signInThroughUi(p, e2);
  await p.click("text=Sign out");
  await expect(p.locator("#acct-email")).toBeVisible();
  expect((await browserFetch(p, "/api/account/me")).status).toBe(401);
  await ctx.close();
});
