import fs from "node:fs";
import { request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDatabase, assertTestTargetDeclared } from "../../../src/lib/env/test-safety";

export const BASE = process.env.E2E_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3100";
export const OWNER = { email: process.env.UI_TEST_ADMIN_EMAIL, password: process.env.UI_TEST_ADMIN_PASSWORD };
export const hasOwner = () => !!(OWNER.email && OWNER.password);
export const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Prisma for test set-up and look-ups only, and only against a database proven disposable (the server was proven too, in global-setup). */
let prisma: PrismaClient | null = null;
export function db(): PrismaClient {
  if (!prisma) {
    assertTestTargetDeclared();
    assertDisposableDatabase(process.env, "browser tests");
    prisma = new PrismaClient();
  }
  return prisma;
}
export async function closeDb() {
  await prisma?.$disconnect();
  prisma = null;
}

/**
 * An API session signed in as the owner account verify:full created for this run. The admin login is rate limited (8 per 15 minutes per IP),
 * so the session is stored on disk and reused until the server stops accepting it.
 */
const STATE = "test-results/.owner-cookie";
/** Session cookies are `Secure` on a production build, which Playwright's request jar will not send over plain http: pass the cookie header ourselves. */
const asCookieHeader = (res: import("@playwright/test").APIResponse) => {
  const c = res.headersArray().find((h) => h.name.toLowerCase() === "set-cookie")?.value.split(";")[0];
  if (!c) throw new Error("login did not set a session cookie");
  return c;
};
export async function adminApi(): Promise<APIRequestContext> {
  if (!hasOwner()) throw new Error("UI_TEST_ADMIN_EMAIL / UI_TEST_ADMIN_PASSWORD are required for admin API steps");
  const withCookie = (cookie: string) => pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie } });
  if (fs.existsSync(STATE)) {
    const cached = await withCookie(fs.readFileSync(STATE, "utf8"));
    if ((await cached.get("/api/admin/me")).ok()) return cached;
    await cached.dispose();
  }
  const login = await pwRequest.newContext({ baseURL: BASE });
  const r = await login.post("/api/admin/login", { data: { email: OWNER.email, password: OWNER.password } });
  if (!r.ok()) throw new Error(`owner login failed (${r.status()})`);
  const cookie = asCookieHeader(r);
  await login.dispose();
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(STATE, cookie);
  return withCookie(cookie);
}

/** The newest mock sign-in code for an address (server in CUSTOMER_OTP_MODE=mock on a disposable database). */
export async function otpCode(email: string): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  try {
    for (let i = 0; i < 20; i++) {
      const r = await ctx.get(`/api/internal/test-environment/otp?email=${encodeURIComponent(email)}`);
      if (r.ok()) return (await r.json()).code as string;
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`no sign-in code for ${email} (is the server running with CUSTOMER_OTP_MODE=mock?)`);
  } finally {
    await ctx.dispose();
  }
}

/** Sign a shopper in through the real UI: email, emailed code, consent if it is a new account. */
export async function signInThroughUi(page: Page, email: string) {
  await page.goto("/account");
  await page.fill("#acct-email", email);
  await page.click('button:has-text("Email me a code")');
  await page.waitForSelector("#acct-code");
  await page.fill("#acct-code", await otpCode(email));
  await page.click('button:has-text("Sign in")');
  // an existing account lands on the dashboard; a new address is first asked for consent (only after the code proved it)
  const dashboard = page.locator('nav[aria-label="Account sections"]');
  const create = page.locator('button:has-text("Create account and sign in")');
  await dashboard.or(create).first().waitFor();
  if (await create.isVisible()) {
    await page.locator("input[type=checkbox]").first().check();
    await create.click();
  }
  await dashboard.waitFor();
}

/** Rates for the HSN codes of the seeded catalogue. ILLUSTRATIVE test values on a disposable database, not tax advice. */
export async function ensureIllustrativeTaxRates(admin: APIRequestContext) {
  for (const code of ["08013220", "080212", "08025200", "08041020", "08062010", "18069090", "DELIVERY"]) {
    await admin.post("/api/admin/tax-rates", { data: { code, rateBp: code === "DELIVERY" ? 1800 : 500, effectiveFrom: "2020-01-01", note: "e2e illustrative" } }); // 409 when already there is fine
  }
}

/** Fail with the status and body of an unexpected API answer (far more useful than "expected true"). */
export async function must(res: import("@playwright/test").APIResponse, expected: number | number[] = [200, 201]): Promise<import("@playwright/test").APIResponse> {
  const ok = Array.isArray(expected) ? expected : [expected];
  if (!ok.includes(res.status())) throw new Error(`${res.url()} answered ${res.status()}: ${(await res.text()).slice(0, 300)}`);
  return res;
}
