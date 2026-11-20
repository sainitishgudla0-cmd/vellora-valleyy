/** M11 P3-T1: SMTP configuration is complete, encrypted and authenticated before anything can be sent from a deployment. */
import { describe, expect, it } from "vitest";
import { parseSmtpConfig } from "@/lib/env/smtp-config";
import { resolveNotifyConfig } from "@/lib/env/notify-config";
import { resolveOtpConfig } from "@/lib/env/otp-config";

const FROM = "Velora Valley <orders@example.com>";

describe("parseSmtpConfig", () => {
  it("smtps:// is implicit TLS on 465 by default; smtp:// requires STARTTLS on 587 by default", () => {
    expect(parseSmtpConfig({ SMTP_URL: "smtps://u:p@mail.example.com", EMAIL_FROM: FROM }, "production").config).toMatchObject({ host: "mail.example.com", port: 465, secure: true, requireTLS: false, plaintext: false, auth: { user: "u", pass: "p" }, fromDomain: "example.com" });
    expect(parseSmtpConfig({ SMTP_URL: "smtp://u:p@mail.example.com", EMAIL_FROM: FROM }, "production").config).toMatchObject({ port: 587, secure: false, requireTLS: true, plaintext: false });
  });

  it("decodes URL-encoded credentials", () => {
    expect(parseSmtpConfig({ SMTP_URL: "smtps://apikey%40x:p%2Fq%3D@mail.example.com:2465", EMAIL_FROM: "orders@example.com" }, "production").config).toMatchObject({ port: 2465, auth: { user: "apikey@x", pass: "p/q=" } });
  });

  it("refuses missing pieces, other schemes, bad senders and missing credentials in deployments, without echoing the URL", () => {
    const secretUrl = "smtps://user:very-secret@mail.example.com";
    for (const [env, appEnv] of [
      [{ EMAIL_FROM: FROM }, "production"],
      [{ SMTP_URL: secretUrl }, "production"],
      [{ SMTP_URL: "https://user:very-secret@mail.example.com", EMAIL_FROM: FROM }, "production"],
      [{ SMTP_URL: secretUrl, EMAIL_FROM: "not an address" }, "production"],
      [{ SMTP_URL: "smtps://mail.example.com", EMAIL_FROM: FROM }, "preview"],
      [{ SMTP_URL: "::::", EMAIL_FROM: FROM }, "test"],
    ] as const) {
      const r = parseSmtpConfig(env, appEnv);
      expect(r.config, JSON.stringify(env)).toBeNull();
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues.join(" ")).not.toContain("very-secret");
    }
  });

  it("plaintext only to loopback in development/test, and only when asked for", () => {
    expect(parseSmtpConfig({ SMTP_URL: "smtp://127.0.0.1:2525?tls=off", EMAIL_FROM: FROM }, "test").config).toMatchObject({ plaintext: true, requireTLS: false, auth: null });
    expect(parseSmtpConfig({ SMTP_URL: "smtp://127.0.0.1:2525", EMAIL_FROM: FROM }, "test").config).toMatchObject({ plaintext: false, requireTLS: true });
    expect(parseSmtpConfig({ SMTP_URL: "smtp://u:p@mail.example.com?tls=off", EMAIL_FROM: FROM }, "test").config).toBeNull();
    expect(parseSmtpConfig({ SMTP_URL: "smtp://u:p@127.0.0.1:2525?tls=off", EMAIL_FROM: FROM }, "production").config).toBeNull();
  });
});

describe("modes", () => {
  const smtp = { SMTP_URL: "smtps://u:p@mail.example.com", EMAIL_FROM: FROM };
  it("NOTIFY_MODE=smtp and CUSTOMER_OTP_MODE=email are allowed in production with a complete configuration", () => {
    expect(resolveNotifyConfig({ VERCEL_ENV: "production", NOTIFY_MODE: "smtp", ...smtp })).toMatchObject({ mode: "smtp", smtp: { host: "mail.example.com" } });
    expect(resolveOtpConfig({ VERCEL_ENV: "production", CUSTOMER_OTP_MODE: "email", ...smtp })).toMatchObject({ mode: "email", smtp: { host: "mail.example.com" } });
  });
  it("and refused (build fails) without one", () => {
    expect(() => resolveNotifyConfig({ VERCEL_ENV: "production", NOTIFY_MODE: "smtp" })).toThrow(/SMTP_URL/);
    expect(() => resolveOtpConfig({ VERCEL_ENV: "production", CUSTOMER_OTP_MODE: "email", SMTP_URL: smtp.SMTP_URL })).toThrow(/EMAIL_FROM/);
  });
  it("mock modes stay refused in deployments", () => {
    expect(() => resolveNotifyConfig({ VERCEL_ENV: "production", NOTIFY_MODE: "mock" })).toThrow();
    expect(() => resolveOtpConfig({ VERCEL_ENV: "preview", CUSTOMER_OTP_MODE: "mock" })).toThrow();
  });
});
