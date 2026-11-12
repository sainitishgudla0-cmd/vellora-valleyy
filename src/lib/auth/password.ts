import "server-only";
import crypto from "node:crypto";

/**
 * Password hashing with scrypt (built into Node: no dependency). Format: `scrypt$N$r$p$salt$hash` (base64url), so
 * the cost can be raised later and old hashes still verify. N=2^15, r=8, p=1 ≈ 80 ms and 32 MB per hash.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const nn = Number(n), rr = Number(r), pp = Number(p);
  if (![nn, rr, pp].every((x) => Number.isInteger(x) && x > 0) || nn > 1 << 20) return false;
  try {
    const expected = Buffer.from(hash, "base64url");
    const actual = await scrypt(pw, Buffer.from(salt, "base64url"), nn, rr, pp);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** Spend the same time as a real check, so unknown or locked accounts cannot be told apart by response time. */
export async function burnPasswordCheck(pw: string): Promise<void> {
  dummy ??= hashPassword("not-a-real-password");
  await verifyPassword(pw, await dummy);
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** Returns a problem description, or null when the password is acceptable. */
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (new Set(pw).size < 5) return "Password is too repetitive";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) return "Password must not contain your email name";
  return null;
}
