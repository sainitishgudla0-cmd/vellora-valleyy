/**
 * M11 P5 accessibility baseline (no extra dependency): on every storefront page, the account page and the admin screens,
 * the essentials WCAG 2.1 A checks a screen-reader user depends on: page language (3.1.1), a top-level heading (1.3.1),
 * image text alternatives (1.1.1), labelled form controls (1.3.1/4.1.2), named buttons and links (2.4.4/4.1.2), unique
 * ids (4.1.1). Colour contrast and keyboard order need a human review (listed in the tracker).
 */
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { adminApi, BASE, hasOwner } from "./support/env";
import { DESKTOP, newContext, settle } from "./support/page";

const STOREFRONT = ["/", "/shop", "/product/premium-cashews", "/our-story", "/quality", "/business", "/contact", "/cart", "/checkout", "/account"];
const ADMIN = ["/admin?tab=orders", "/admin?tab=products", "/admin?tab=operations", "/admin?tab=settings", "/admin?tab=account"];

async function audit(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0);
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(" ").slice(0, 2).join(".")}` : ""}`;
    const name = (el: Element): string => {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) return labelledby.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      return (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || [...el.querySelectorAll("img[alt],svg title")].map((i) => i.getAttribute("alt") ?? i.textContent).join(" ") || "").trim();
    };
    if (!document.documentElement.lang) problems.push("html has no lang");
    if (!document.querySelector("h1")) problems.push("no h1");
    for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt") && img.getAttribute("role") !== "presentation" && img.getAttribute("aria-hidden") !== "true") problems.push(`img without alt: ${img.getAttribute("src")?.slice(0, 60)}`);
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const t = (el as HTMLInputElement).type;
      if (["hidden", "submit", "button", "reset", "image"].includes(t) || !visible(el) || el.getAttribute("aria-hidden") === "true") continue;
      const id = el.id;
      const labelled = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title");
      if (!labelled) problems.push(`unlabelled control: ${describe(el)}`);
    }
    for (const el of document.querySelectorAll("button, a[href], [role=button]")) {
      if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
      if (!name(el)) problems.push(`no accessible name: ${describe(el)}`);
    }
    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1 && id) problems.push(`duplicate id: ${id} (${n})`);
    return problems;
  });
}

test.describe.configure({ mode: "serial" });

test("the checks catch real problems (self-test on a deliberately broken page)", async ({ browser }) => {
  const ctx = await newContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await page.setContent(`<html><body><img src="x.png"><input id="a"><input id="a"><button></button><a href="/x"></a></body></html>`);
  const p = await audit(page);
  await ctx.close();
  for (const want of ["html has no lang", "no h1", "img without alt", "unlabelled control", "no accessible name: button", "no accessible name: a", "duplicate id: a"]) expect(p.join("\n")).toContain(want);
});

test("storefront and account pages meet the accessibility baseline", async ({ browser }) => {
  const ctx = await newContext(browser, { ...DESKTOP, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const found: Record<string, string[]> = {};
  for (const path of STOREFRONT) {
    await page.goto(path);
    await settle(page);
    const p = await audit(page);
    if (p.length) found[path] = p;
  }
  await ctx.close();
  expect(found).toEqual({});
});

test("admin screens meet the accessibility baseline", async ({ browser }) => {
  test.skip(!hasOwner(), "needs the throwaway owner account that verify:full creates");
  await (await adminApi()).dispose(); // signs in once (or reuses the cached session) and caches the cookie
  const ctx = await newContext(browser, DESKTOP);
  const [cname, value] = fs.readFileSync("test-results/.owner-cookie", "utf8").split("=");
  await ctx.addCookies([{ name: cname, value, url: BASE }]);
  const page = await ctx.newPage();
  const found: Record<string, string[]> = {};
  for (const path of ADMIN) {
    await page.goto(path);
    const p = await audit(page);
    if (p.length) found[path] = p;
  }
  await ctx.close();
  expect(found).toEqual({});
});
