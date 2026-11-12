import "server-only";
import crypto from "node:crypto";
import { db } from "@/lib/db";

/**
 * Linking past guest orders to an account (M5-T5, ADR 0013). Two proofs, both server-checked:
 *  - by verified email: the customer proved control of the address by signing in, so guest orders placed with that
 *    address (any capitalisation) that nobody has claimed yet become theirs;
 *  - by order number + access token: possession of the guest link proves the order is theirs, whatever email they typed.
 * An order already linked to anyone is never re-linked, and a wrong token looks exactly like a missing order.
 * (Phone-based claiming needs phone verification and is deferred with SMS OTP.)
 */
export async function claimByVerifiedEmail(customerId: string, email: string): Promise<number> {
  const r = await db.order.updateMany({ where: { customerId: null, email: { equals: email, mode: "insensitive" } }, data: { customerId } });
  return r.count;
}

const same = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

export async function claimByToken(customerId: string, number: string, token: string): Promise<"claimed" | "already_yours" | "not_found"> {
  const o = await db.order.findUnique({ where: { number }, select: { id: true, accessToken: true, customerId: true } });
  if (!o || !same(o.accessToken, token)) return "not_found";
  if (o.customerId === customerId) return "already_yours";
  if (o.customerId !== null) return "not_found"; // someone else's: never reveal that
  const r = await db.order.updateMany({ where: { id: o.id, customerId: null }, data: { customerId } });
  return r.count === 1 ? "claimed" : "not_found";
}
