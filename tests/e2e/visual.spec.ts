/**
 * Visual regression of the EXISTING customer pages (M8 acceptance: "existing pages are visually unchanged").
 * Baselines were captured on the code BEFORE any M8 frontend change; a diff above 0.1% of pixels fails. Pages that M8 adds are not
 * in this list (they have no baseline), and baselines exist per platform: where none exists (e.g. Linux CI) the test skips.
 * Update deliberately with `npx playwright test visual --update-snapshots` after an approved design change.
 */
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { DESKTOP, MOBILE, newContext, settle } from "./support/page";

const PAGES: [string, string][] = [
  ["home", "/"],
  ["shop", "/shop"],
  ["shop-seeds", "/shop?category=seeds"],
  ["product-kimia-dates", "/product/kimia-dates"],
  ["product-premium-cashews", "/product/premium-cashews"],
  ["our-story", "/our-story"],
  ["quality", "/quality"],
  ["business", "/business"],
  ["contact", "/contact"],
  ["cart-empty", "/cart"],
  ["checkout-empty", "/checkout"],
];
const VIEWPORTS = { desktop: DESKTOP, mobile: MOBILE } as const;

for (const [vp, opts] of Object.entries(VIEWPORTS)) {
  for (const [name, path] of PAGES) {
    test(`${name} (${vp})`, async ({ browser }, testInfo) => {
      const file = `${name}-${vp}.png`;
      test.skip(!fs.existsSync(testInfo.snapshotPath(file)) && !/^(all|changed)$/.test(testInfo.config.updateSnapshots), `no ${process.platform} baseline yet`);
      const ctx = await newContext(browser, { ...opts, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(path);
      await settle(page);
      await expect(page).toHaveScreenshot(file, { fullPage: true });
      await ctx.close();
    });
  }
}
