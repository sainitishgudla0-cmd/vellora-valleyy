import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;
export const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
export const TABLET = { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } as const;

/** A context that skips the intro loader (as the real site does after the first visit in a session). */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem("vv-intro", "1");
    } catch {
      /* ignore */
    }
  });
  return ctx;
}

/** Lift the html/body clip, scroll through the page so reveals settle, then report content wider than the viewport. */
export async function overflowOf(page: Page) {
  return page.evaluate(async () => {
    document.documentElement.style.overflowX = "visible";
    document.body.style.overflowX = "visible";
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += window.innerHeight * 0.8) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 1500));
    window.scrollTo(0, 0);
    const off = [...document.querySelectorAll("main *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= window.innerWidth + 1) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return false; // inside its own clipping container
        return true;
      })
      .slice(0, 3)
      .map((el) => el.tagName + "." + String(el.className).slice(0, 60));
    return { px: document.documentElement.scrollWidth - window.innerWidth, off };
  });
}

/** Wait until a page is visually still: network idle, fonts loaded, lazy images triggered by scrolling through it. */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    // lazy images in offscreen carousels never enter the viewport: load them all, so a screenshot never depends on scroll position
    for (const img of document.querySelectorAll<HTMLImageElement>("img[loading=lazy]")) img.loading = "eager";
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += window.innerHeight * 0.7) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, 0);
    const loaded = Promise.all([...document.images].map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = i.onerror = () => r(null); }))));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 6000))]); // bounded: never hang on an image that cannot load
  });
  await page.waitForTimeout(500);
}

/** Collects browser errors, ignoring the deliberate 4xx responses and missing favicons. Call `expectClean` at the end of a test. */
export function watchErrors(page: Page, tag = "page") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(`[${tag}] console: ${m.text().slice(0, 300)}`);
  });
  return { errors, expectClean: () => expect(errors, errors.join("\n")).toEqual([]) };
}

/** An authenticated call made by the browser itself (cookies, Secure flag and all), for what Playwright's own request jar cannot send over http. */
export async function browserFetch(page: Page, url: string, init?: { method?: string; body?: unknown }) {
  const r = await page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, { method: init?.method, headers: init?.body ? { "Content-Type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), base64: btoa(bin) };
    },
    { url, init },
  );
  const body = Buffer.from(r.base64, "base64");
  return { status: r.status, headers: r.headers as Record<string, string>, body, text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
}
