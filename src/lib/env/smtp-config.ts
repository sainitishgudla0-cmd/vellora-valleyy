import type { AppEnv, EnvSource } from "./app-env";

/**
 * SMTP transport configuration (M11 P3-T1, findings F09/F10). Pure: shared by `env:check`, notification and sign-in code
 * delivery. Vendor-neutral on purpose: whichever email provider the business chooses (SES, Postmark, Zoho, Google
 * Workspace, Resend, …) offers SMTP. Nothing is sent unless an operator sets these variables AND enables a mode
 * (`NOTIFY_MODE=smtp`, `CUSTOMER_OTP_MODE=email`).
 *
 *  SMTP_URL   smtps://USER:PASS@host:465  (implicit TLS)  or  smtp://USER:PASS@host:587  (STARTTLS, required)
 *             Credentials are URL-encoded in the URL. The URL is a secret: never logged or printed.
 *  EMAIL_FROM "Velora Valley <orders@example.com>" or a bare address, on a domain the provider has verified.
 *
 * In preview/production: credentials are required and the connection must be encrypted (implicit TLS, or STARTTLS
 * that the client insists on). Unencrypted SMTP is allowed only to a loopback host in development/test (local catchers).
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** implicit TLS (smtps://) */
  secure: boolean;
  /** refuse to send unless the server upgrades with STARTTLS */
  requireTLS: boolean;
  /** development/test loopback only: no TLS at all */
  plaintext: boolean;
  auth: { user: string; pass: string } | null;
  from: string;
  fromDomain: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ADDRESS = /^[^\s@<>"]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

/** Parses SMTP_URL + EMAIL_FROM. Returns the issues instead of throwing; never echoes the URL (it holds a password). */
export function parseSmtpConfig(env: EnvSource, appEnv: AppEnv): { config: SmtpConfig | null; issues: string[] } {
  const issues: string[] = [];
  const raw = env.SMTP_URL?.trim();
  const fromRaw = env.EMAIL_FROM?.trim();
  if (!raw) issues.push("SMTP_URL is not set.");
  if (!fromRaw) issues.push("EMAIL_FROM is not set.");
  if (!raw || !fromRaw) return { config: null, issues };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { config: null, issues: ["SMTP_URL is not a valid URL (smtps://user:pass@host:465 or smtp://user:pass@host:587)."] };
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") issues.push("SMTP_URL must start with smtps:// or smtp://.");
  const secure = url.protocol === "smtps:";
  const host = url.hostname;
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  if (!host) issues.push("SMTP_URL has no host.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push("SMTP_URL has an invalid port.");
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const auth = user ? { user, pass } : null;
  const deployed = appEnv === "preview" || appEnv === "production";
  const insecureLocal = !deployed && !secure && LOOPBACK.has(host) && url.searchParams.get("tls") === "off";
  if (deployed && (!user || !pass)) issues.push("SMTP_URL must carry the provider's username and password in preview/production.");
  if (url.searchParams.get("tls") === "off" && !insecureLocal) issues.push("tls=off is only allowed for a loopback SMTP server in development/test.");

  const m = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/.exec(fromRaw);
  const address = (m ? m[2] : fromRaw).trim();
  const domain = ADDRESS.exec(address)?.[1];
  if (!domain) issues.push('EMAIL_FROM must be an email address, optionally with a name: "Velora Valley <orders@example.com>".');

  if (issues.length) return { config: null, issues };
  return {
    config: { host, port, secure, requireTLS: !secure && !insecureLocal, plaintext: insecureLocal, auth, from: fromRaw, fromDomain: domain!.toLowerCase() },
    issues: [],
  };
}
