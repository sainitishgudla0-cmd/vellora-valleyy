/** Admin UI journey (M4-T6, ported): owner sign-in, Account and Team tabs, a viewer's limits, password change and the shared-password transition login. */
import { expect, test } from "@playwright/test";
import { adminApi, BASE, hasOwner, OWNER as MAIN_OWNER, stamp } from "./support/env";
import { DESKTOP, newContext, watchErrors } from "./support/page";

test.describe.configure({ mode: "serial" });
test.skip(!hasOwner(), "needs the owner account created by verify:full (UI_TEST_ADMIN_*)");

// The journey signs in as, and changes the password of, a TEMPORARY owner created through the API, so the shared owner session used by the
// other specs is never revoked. (Logins are rate limited, hence one temporary owner and a handful of sign-ins in total.)
const OWNER = { email: `smoke.ui-owner2-${stamp()}@example.com`, password: "temporary-owner-passphrase-1" as string | undefined };
const NEW_PW = () => `${OWNER.password}-changed`;
void MAIN_OWNER;

test("owner journey: team, viewer limits, activity log, password change", async ({ browser }) => {
  const api = await adminApi();
  expect((await api.post("/api/admin/users", { data: { email: OWNER.email, name: "UI Owner Two", role: "owner", password: OWNER.password } })).status()).toBe(201);
  await api.dispose();
  const viewerEmail = `smoke.ui-viewer-${stamp()}@example.com`;
  const VIEWER_PW = "viewer-ui-test-passphrase-1";
  const signIn = async (page: import("@playwright/test").Page, email: string | null, pw: string) => {
    await page.goto("/admin", { waitUntil: "networkidle" });
    if (email) await page.fill("#admin-email", email);
    await page.fill("#admin-pw", pw);
    await page.click('button:has-text("Sign in")');
  };
  const ctx = await newContext(browser, DESKTOP);
  const page = await ctx.newPage();
  const errs = watchErrors(page, "admin");
  const tab = (name: string) => page.locator(`nav[aria-label="Admin sections"] a:has-text("${name}")`);

  await page.goto("/admin", { waitUntil: "networkidle" });
  await expect(page.locator("#admin-email")).toBeVisible();
  await expect(page.locator("#admin-pw")).toBeVisible();
  await signIn(page, OWNER.email!, OWNER.password!);
  await expect(page.getByTestId("admin-identity")).toContainText(`${OWNER.email} · owner`);
  for (const t of ["Orders", "Enquiries", "Products", "Account", "Team"]) await expect(tab(t)).toBeVisible();

  await tab("Account").click();
  await expect(page.getByText("Your sessions")).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();
  await expect(page.locator("#pw-current")).toBeVisible();

  await tab("Team").click();
  await expect(page.getByText("Add a person")).toBeVisible();
  await page.fill("#new-name", "UI Viewer");
  await page.fill("#new-email", viewerEmail);
  await page.selectOption("#new-role", "viewer");
  await page.fill("#new-password", "short");
  await page.evaluate(() => document.querySelector("#new-password")!.removeAttribute("minlength"));
  await page.click('button:has-text("Add person")');
  await expect(page.locator(".field-error")).toContainText(/at least 12/i);
  await page.fill("#new-password", VIEWER_PW);
  await page.click('button:has-text("Add person")');
  const row = page.locator(`tr:has-text("${viewerEmail}")`);
  await expect(row.getByText("Active")).toBeVisible();

  const vctx = await newContext(browser, DESKTOP);
  const vp = await vctx.newPage();
  await signIn(vp, viewerEmail, VIEWER_PW);
  await expect(vp.getByTestId("admin-identity")).toContainText("· viewer");
  await expect(vp.locator('nav[aria-label="Admin sections"] a:has-text("Team")')).toBeHidden();
  expect(await vp.evaluate(async () => (await fetch("/api/admin/users")).status)).toBe(403);

  page.once("dialog", (d) => d.accept());
  await row.locator('button:has-text("Disable")').click();
  await expect(row.getByText("Disabled").first()).toBeVisible();
  expect(await vp.evaluate(async () => (await fetch("/api/admin/me")).status), "disabling ends their session at once").toBe(401);
  await tab("Team").click();
  await expect(page.getByText("Recent activity")).toBeVisible();
  await expect(page.locator('td:has-text("user.create")').first()).toBeVisible();

  await tab("Account").click();
  await page.fill("#pw-current", OWNER.password!);
  await page.fill("#pw-new", NEW_PW());
  await page.fill("#pw-again", NEW_PW());
  await page.click('button:has-text("Change password")');
  await expect(page.locator('[role=status]:has-text("Password changed")')).toBeVisible();
  await page.click("text=Sign out");
  await expect(page.locator("#admin-email")).toBeVisible();
  expect(await page.evaluate(async () => (await fetch("/api/admin/me")).status)).toBe(401);
  await signIn(page, OWNER.email!, OWNER.password!);
  await expect(page.locator(".field-error")).toContainText("Incorrect");
  await page.fill("#admin-pw", NEW_PW());
  await page.click('button:has-text("Sign in")');
  await expect(page.getByTestId("admin-identity")).toBeVisible();
  errs.expectClean();
  await vctx.close();
  await ctx.close();
});

test("the shared-password sign-in still works from the unchanged form (empty email)", async ({ browser }) => {
  test.skip(!process.env.ADMIN_PASSWORD, "no shared ADMIN_PASSWORD configured");
  const ctx = await newContext(browser, DESKTOP);
  const page = await ctx.newPage();
  await page.goto("/admin", { waitUntil: "networkidle" });
  await page.fill("#admin-pw", process.env.ADMIN_PASSWORD!);
  await page.click('button:has-text("Sign in")');
  await expect(page.getByTestId("admin-identity")).toContainText("Shared password");
  await expect(page.locator('nav[aria-label="Admin sections"] a:has-text("Team")')).toBeHidden();
  await ctx.close();
  expect(BASE).toBeTruthy();
});
