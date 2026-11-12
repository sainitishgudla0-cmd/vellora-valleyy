/** Wholesale journey (M6, M8-T3): apply with a GSTIN, staff approve and set prices, the buyer asks for a quote, staff price it, the buyer accepts. */
import { expect, test, type Page } from "@playwright/test";
import { gstinCheckChar } from "../../src/lib/wholesale/gstin";
import { adminApi, closeDb, db, ensureIllustrativeTaxRates, hasOwner, signInThroughUi, stamp } from "./support/env";
import { browserFetch, DESKTOP, newContext, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });
test.skip(!hasOwner(), "needs the owner account created by verify:full (UI_TEST_ADMIN_*)");

const email = `smoke.buyer-${stamp()}@example.com`;
const body = `29AAB${stamp().toUpperCase().replace(/[^A-Z]/g, "X").padEnd(2, "X").slice(0, 2)}${String(Date.now()).slice(-4)}A1Z`;
const gstin = body + gstinCheckChar(body);
let page: Page;
let errors: ReturnType<typeof watchErrors>;
let variantId = "";
let variantLabel = "";
let quoteNumber = "";

test.beforeAll(async ({ browser }) => {
  const ctx = await newContext(browser, DESKTOP);
  page = await ctx.newPage();
  errors = watchErrors(page, "wholesale");
  const v = await db().variant.findFirstOrThrow({ where: { inStock: true, trackInventory: false, product: { active: true }, price: { gte: 20000 } }, include: { product: true } });
  variantId = v.id;
  variantLabel = `${v.product.name} (${v.label})`;
});
test.afterAll(async () => {
  await page.context().close();
  await closeDb();
});

test("a signed-in shopper applies for a business account (a wrong GSTIN is explained first)", async () => {
  await signInThroughUi(page, email);
  await page.goto("/account?tab=business");
  await expect(page.getByRole("form", { name: "Apply for a business account" })).toBeVisible();
  await page.fill("#ba-company", "Rao Traders E2E");
  await page.fill("#ba-gstin", gstin.slice(0, 14) + (gstin[14] === "A" ? "B" : "A"));
  await page.fill("#ba-contact", "Asha Rao");
  await page.fill("#ba-phone", "9876543210");
  await page.click('button:has-text("Send application")');
  await expect(page.locator(".field-error")).toContainText(/check character|GSTIN/i);
  await page.fill("#ba-gstin", gstin);
  await page.selectOption("#ba-interest", "retail");
  await page.click('button:has-text("Send application")');
  await expect(page.getByTestId("business-status")).toContainText("being reviewed");
  // pending buyers cannot see prices or quotes
  expect((await browserFetch(page, "/api/business/price-list")).status).toBe(403);
});

test("staff approve the account and set its prices and order rules", async () => {
  const account = await db().businessAccount.findFirstOrThrow({ where: { gstin } });
  const admin = await adminApi();
  try {
    const v = await db().variant.findUniqueOrThrow({ where: { id: variantId } });
    const list = await admin.post("/api/admin/price-lists", { data: { name: `e2e-${stamp()}`, description: "e2e" } });
    expect(list.status()).toBe(201);
    const listId = (await list.json()).priceList.id as string;
    const tier = await admin.put(`/api/admin/price-lists/${listId}/items`, { data: { variantId, tiers: [{ minQty: 10, unitPrice: Math.floor(v.price * 0.8) }, { minQty: 100, unitPrice: Math.floor(v.price * 0.7) }] } });
    expect(tier.status()).toBe(200);
    expect((await admin.put(`/api/admin/variants/${variantId}/wholesale`, { data: { moq: 10, casePack: 1 } })).status()).toBe(200);
    const ok = await admin.patch(`/api/admin/wholesale/accounts/${account.id}`, { data: { status: "approved", priceListId: listId, paymentTerms: "prepaid" } });
    expect(ok.status(), await ok.text()).toBe(200);
  } finally {
    await admin.dispose();
  }
  await page.goto("/account?tab=business");
  await expect(page.getByTestId("business-status")).toContainText("approved");
  const row = page.getByTestId("price-row").filter({ hasText: variantLabel.split(" (")[0] }).first();
  await expect(row).toContainText("Min 10");
  await expect(row).toContainText("from 10");
  await expect(row).toContainText("from 100");
});

test("quote request: the order rules are explained; a valid request waits for staff", async () => {
  await page.goto("/account?tab=business");
  const form = page.getByRole("form", { name: "Request a quote" });
  await form.locator("#qr-v-0").selectOption(variantId);
  await form.locator("#qr-q-0").fill("3");
  await form.getByRole("button", { name: "Request quote" }).click();
  await expect(form.locator(".field-error")).toContainText("Minimum order is 10");
  await form.locator("#qr-q-0").fill("24");
  await form.getByRole("button", { name: "Request quote" }).click();
  const card = page.getByTestId("quote").first();
  await expect(card).toContainText("Waiting for our price");
  await expect(card).toContainText("24 ×");
  await expect(card.getByTestId("quote-total")).toHaveCount(0); // no price before staff quote
  quoteNumber = (await card.getAttribute("data-number"))!;
  expect(quoteNumber).toMatch(/^QT-/);
});

test("staff price the quote; the buyer accepts it and gets an order at exactly that price", async () => {
  const quote = await db().quote.findUniqueOrThrow({ where: { number: quoteNumber } });
  const admin = await adminApi();
  try {
    await ensureIllustrativeTaxRates(admin);
    const priced = await admin.patch(`/api/admin/quotes/${quote.id}`, { data: { action: "quote", items: [{ variantId, unitPrice: 15000 }], deliveryFee: 5000, validDays: 7, buyerNote: "Ex-warehouse, payment before dispatch" } });
    expect(priced.status(), await priced.text()).toBe(200);
  } finally {
    await admin.dispose();
  }
  await page.goto("/account?tab=business");
  const card = page.locator(`[data-number="${quoteNumber}"]`);
  await expect(card).toContainText("Priced");
  await expect(card.getByTestId("quote-total")).toContainText("₹3,650"); // 24 x 150 + 50 delivery
  await expect(card).toContainText("Ex-warehouse, payment before dispatch");
  await card.getByRole("button", { name: "Accept this quote" }).click();
  const form = page.getByRole("form", { name: `Accept quote ${quoteNumber}` });
  await form.locator(`#ac-n-${quoteNumber}`).fill("Asha Rao");
  await form.locator(`#ac-p-${quoteNumber}`).fill("9876543210");
  await form.locator(`#ac-e-${quoteNumber}`).fill("orders@rao-traders.example.com");
  await form.locator(`#ac-a-${quoteNumber}`).fill("12 Market Yard Road");
  await form.locator(`#ac-c-${quoteNumber}`).fill("Anantapur");
  await form.locator(`#ac-pin-${quoteNumber}`).fill("515001");
  await form.locator(`#ac-s-${quoteNumber}`).selectOption("Andhra Pradesh");
  await form.getByRole("button", { name: /Place order for/ }).click();
  await expect(card.getByRole("status")).toContainText("Order placed");

  const done = await db().quote.findUniqueOrThrow({ where: { number: quoteNumber }, include: { order: { include: { items: true } } } });
  expect(done.status).toBe("accepted");
  expect(done.order).toMatchObject({ total: 365000, subtotal: 360000, deliveryFee: 5000, paymentMethod: "cod" });
  expect(done.order!.items[0]).toMatchObject({ unitPrice: 15000, quantity: 24 });
  expect(done.order!.businessAccountId).not.toBeNull();

  await card.getByRole("link", { name: /View order/ }).click();
  await expect(page).toHaveURL(/\/order\/VV-/);
  await expect(page.getByText("₹3,650")).toBeVisible();
  await page.goto("/account?tab=business");
  await expect(page.locator(`[data-number="${quoteNumber}"]`)).toContainText("Accepted");
  errors.expectClean();
});
