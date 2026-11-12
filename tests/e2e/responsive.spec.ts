/** Layout checks ported from the old browser script (M8-T5): no horizontal overflow at any size, mobile menu and filters, reduced motion. */
import { expect, test } from "@playwright/test";
import { DESKTOP, MOBILE, TABLET, newContext, overflowOf, watchErrors } from "./support/page";

test("no horizontal overflow on key pages (desktop)", async ({ browser }) => {
  const ctx = await newContext(browser, DESKTOP);
  const page = await ctx.newPage();
  const errs = watchErrors(page, "desktop");
  for (const path of ["/", "/shop", "/product/safawi-dates", "/our-story", "/quality", "/business", "/contact"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const ov = await overflowOf(page);
    expect(ov.off, `overflow on ${path}`).toEqual([]);
  }
  errs.expectClean();
  await ctx.close();
});

test("mobile (390px): no overflow, menu, submenu and filter drawer", async ({ browser }) => {
  const ctx = await newContext(browser, MOBILE);
  const page = await ctx.newPage();
  const errs = watchErrors(page, "mobile");
  for (const path of ["/", "/shop", "/product/premium-cashews", "/cart", "/checkout", "/our-story", "/quality", "/business", "/contact"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    expect((await overflowOf(page)).off, `overflow on ${path}`).toEqual([]);
  }
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.click("button[aria-controls=mobile-menu]");
  await expect(page.locator("#mobile-menu")).toBeVisible();
  await page.click('#mobile-menu button[aria-label="Show Dates links"]');
  await expect(page.locator("#mobile-menu").getByText("Safawi Dates")).toBeVisible();
  await page.click("button[aria-controls=mobile-menu]");
  await page.goto("/shop", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Filters")');
  await expect(page.locator("[role=dialog][aria-label=Filters]")).toBeVisible();
  errs.expectClean();
  await ctx.close();
});

test("tablet (768px): no overflow", async ({ browser }) => {
  const ctx = await newContext(browser, TABLET);
  const page = await ctx.newPage();
  for (const path of ["/", "/shop", "/product/kimia-dates", "/checkout", "/our-story", "/quality", "/business"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    expect((await overflowOf(page)).off, `overflow on ${path}`).toEqual([]);
  }
  await ctx.close();
});

test("reduced motion: content visible, no intro loader", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => [...document.querySelectorAll("[data-reveal],[data-hero-anim]")].filter((e) => getComputedStyle(e).opacity === "0").length)).toBe(0);
  expect(await page.evaluate(() => !!document.querySelector(".fixed.inset-0.z-\\[100\\]"))).toBe(false);
  await ctx.close();
});
