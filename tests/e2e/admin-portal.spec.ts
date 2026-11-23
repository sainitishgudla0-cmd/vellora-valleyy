/**
 * M12 admin-portal acceptance (complements admin.spec.ts and admin-operations.spec.ts): a staff member on a phone. A wrong
 * password is refused without a session; the correct one signs an OPERATIONS account in; that role sees its sections and
 * not Team, and the server refuses what it may not do; enquiries can be worked; the Operations tab carries the sales
 * summary; nothing overflows the phone screen; sign-out ends the session on the server.
 * Two admin sign-ins in total (the login limiter allows 8 per 15 minutes per IP for the whole run).
 */
import { expect, test } from "@playwright/test";
import { adminApi, closeDb, db, hasOwner, must, stamp } from "./support/env";
import { MOBILE, newContext, overflowOf, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });
test.skip(!hasOwner(), "needs the throwaway owner account that verify:full creates");
test.afterAll(async () => closeDb());

const OPS = { email: `smoke.ui-ops-${stamp()}@example.com`, password: "operations-ui-passphrase-1" };
const ENQUIRY_NAME = `SMOKE TEST Portal ${stamp()}`;

test("operations staff on a phone: wrong password refused, own sections only, enquiries, sales, no overflow, sign out", async ({ browser }) => {
  const api = await adminApi();
  try {
    expect((await api.post("/api/admin/users", { data: { email: OPS.email, name: "UI Operations", role: "operations", password: OPS.password } })).status()).toBe(201);
    await must(await api.post("/api/enquiries", { data: { type: "contact", name: ENQUIRY_NAME, email: `smoke.portal-${stamp()}@example.com`, message: "Portal acceptance enquiry, please ignore." } }));
  } finally {
    await api.dispose();
  }

  const ctx = await newContext(browser, MOBILE);
  const page = await ctx.newPage();
  const errs = watchErrors(page, "admin-mobile");
  const status = (url: string, method = "GET", body?: unknown) =>
    page.evaluate(async ({ url, method, body }) => (await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })).status, { url, method, body });

  await page.goto("/admin", { waitUntil: "networkidle" });
  expect((await overflowOf(page)).px, "login screen fits the phone").toBeLessThanOrEqual(1);
  await page.fill("#admin-email", OPS.email);
  await page.fill("#admin-pw", "not-the-password-at-all");
  await page.click('button:has-text("Sign in")');
  await expect(page.locator(".field-error")).toContainText("Incorrect");
  expect(await status("/api/admin/me"), "a refused sign-in creates no session").toBe(401);

  await page.fill("#admin-pw", OPS.password);
  await page.click('button:has-text("Sign in")');
  await expect(page.getByTestId("admin-identity")).toContainText(`${OPS.email} · operations`);
  const nav = page.locator('nav[aria-label="Admin sections"]');
  for (const t of ["orders", "enquiries", "products", "operations", "wholesale", "settings", "account"]) await expect(nav.locator(`a[href="/admin?tab=${t}"]`)).toHaveCount(1);
  await expect(nav.locator('a[href="/admin?tab=team"]')).toHaveCount(0);
  expect((await overflowOf(page)).px, "dashboard fits the phone (tables scroll inside their own box)").toBeLessThanOrEqual(1);
  // every section link must be reachable on the phone: on screen, or in a tab bar that scrolls (not clipped away)
  const reach = await nav.evaluate((el) => {
    const style = getComputedStyle(el);
    const scrolls = (style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth;
    const hidden = [...el.querySelectorAll("a")].filter((a) => a.getBoundingClientRect().right > window.innerWidth + 1).map((a) => a.textContent);
    return { scrolls, hidden };
  });
  expect(reach.hidden.length === 0 || reach.scrolls, `tabs off screen and not scrollable: ${reach.hidden.join(", ")}`).toBe(true);

  // the server, not just the menu, enforces the role
  expect(await status("/api/admin/users")).toBe(403);
  expect(await status("/api/admin/tax-rates", "POST", { code: "0909", rateBp: 500, effectiveFrom: "2099-01-01" })).toBe(403);
  expect(await status("/api/admin/orders/does-not-exist/refunds", "POST", { reason: "x", requestKey: "abcdefgh12" })).toBe(403);

  await nav.locator('a[href="/admin?tab=enquiries"]').click();
  const card = page.locator(`div.rounded-\\[12px\\]:has-text("${ENQUIRY_NAME}")`);
  await expect(card).toBeVisible();
  await card.getByLabel("Enquiry status").selectOption("in_progress");
  await expect.poll(async () => (await db().enquiry.findFirstOrThrow({ where: { name: ENQUIRY_NAME } })).status).toBe("in_progress");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(`div.rounded-\\[12px\\]:has-text("${ENQUIRY_NAME}")`).getByLabel("Enquiry status")).toHaveValue("in_progress");

  await page.locator('nav[aria-label="Admin sections"] a[href="/admin?tab=operations"]').click();
  const sales = page.getByTestId("sales-table");
  await expect(sales).toBeVisible();
  for (const p of ["today", "last7", "month"]) await expect(sales.locator(`tr[data-period="${p}"]`)).toHaveCount(1);
  expect((await overflowOf(page)).px, "operations tab fits the phone").toBeLessThanOrEqual(1);

  await page.click("text=Sign out");
  await expect(page.locator("#admin-email")).toBeVisible();
  expect(await status("/api/admin/me"), "sign-out ends the session on the server").toBe(401);
  errs.expectClean();
  await ctx.close();
});
