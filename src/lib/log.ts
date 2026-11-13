/**
 * Structured logging (M9-T5, ADR 0017). One JSON object per line on stdout/stderr, which Vercel log drains,
 * `vercel logs` and any future monitoring vendor can parse. Pure (no `server-only`) so scripts can share it.
 *
 * Rules (also in .claude/rules/security.md):
 * - Pass identifiers and codes only: order number, reason code, counts. Never error objects, bodies, headers,
 *   tokens, emails, phones or addresses. Field names that look sensitive are redacted as a second line of defence.
 * - `src/` code never calls `console.*` directly (ratchet test `no-console-ratchet`).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogRecord = { ts: string; level: LogLevel; event: string; service: string; env: string; commit?: string } & LogFields;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /pass(word|wd)?|secret|token|authori[sz]ation|cookie|signature|otp|code|e-?mail|phone|address|name|pincode|gstin|key|session|hash|body|payload|card|upi|account/i;
/** Names that look sensitive but are safe identifiers or reasons. */
const ALLOWED = new Set(["reasonCode", "errorCode", "statusCode", "errorName", "accountId", "sessionId"]);
const MAX_STRING = 200;

let sink: ((record: LogRecord) => void) | null = null;

/** Tests capture records here; pass null to restore the console writer. */
export function setLogSink(fn: ((record: LogRecord) => void) | null) {
  sink = fn;
}

function appEnvLabel(): string {
  const v = process.env.VERCEL_ENV?.trim() || process.env.APP_ENV?.trim();
  if (v) return v;
  return process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development";
}

function threshold(): number {
  const set = process.env.LOG_LEVEL?.trim().toLowerCase() as LogLevel | undefined;
  if (set && set in ORDER) return ORDER[set];
  if (process.env.NODE_ENV === "test") return Infinity; // quiet test output unless LOG_LEVEL is set
  return process.env.NODE_ENV === "production" ? ORDER.info : ORDER.debug;
}

export function sanitizeFields(fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!ALLOWED.has(k) && SENSITIVE.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: LogLevel, event: string, fields?: LogFields) {
  if (ORDER[level] < threshold() && !sink) return;
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  // fixed keys come last so a field can never overwrite them
  const record = { ...sanitizeFields(fields), ts: new Date().toISOString(), level, event, service: "velora-valley", env: appEnvLabel(), ...(commit ? { commit } : {}) } as LogRecord;
  if (sink) return sink(record);
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
  /**
   * Human-readable line for local development only (the mock email/OTP senders print the code here so a
   * developer can sign in). Silent in test, preview and production.
   */
  dev: (message: string) => {
    if (appEnvLabel() === "development") console.info(message);
  },
};

/** Short stable code for an unknown thrown value: its class name only, never its message (which can carry customer data). */
export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
