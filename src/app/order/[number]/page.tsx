import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { site } from "@/config/site";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { formatPrice } from "@/lib/format";
import { Frame, HexBadge } from "@/components/ui/Ornaments";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function OrderPage(props: { params: Promise<{ number: string }>; searchParams: Promise<{ t?: string; payment?: string }> }) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const order = await db.order.findUnique({ where: { number: params.number }, include: { items: true } });
  // the access token keeps order details private to the person who placed it
  if (!order || !searchParams.t || searchParams.t !== order.accessToken) notFound();

  const paid = order.paymentStatus === "paid";
  const awaitingPayment = order.status === "awaiting_payment" || searchParams.payment === "failed";

  const headline = paid ? "Thank you! Payment received." : awaitingPayment ? "Payment not completed" : "Thank you! Order request received.";
  const message = paid
    ? `Your payment for order ${order.number} has been verified. Our team will contact you on ${order.phone} with dispatch details.`
    : awaitingPayment
      ? `We have saved order ${order.number}, but the online payment was not completed and no payment has been recorded. Please contact us to complete it, or place the order again with pay on delivery.`
      : `Your order ${order.number} has been received and is awaiting confirmation. No payment has been taken. Our team will call ${order.phone} to confirm availability and any delivery charges before dispatch.`;

  return (
    <div className="container-site pb-24 pt-10 md:pt-14">
      <div className="mx-auto max-w-[760px]">
        <div data-reveal="scale">
          <HexBadge h={44} tone={awaitingPayment ? "butter" : "sage"} innerClassName="px-10 py-10 text-center sm:px-16">
            <p className="eyebrow text-forest/70">Order {order.number}</p>
            <h1 className="mt-3 text-[clamp(2.4rem,5.5vw,4.4rem)] leading-[0.88]">{headline}</h1>
            <p className="mx-auto mt-4 max-w-[52ch] text-[13.5px] leading-relaxed text-forest/80">{message}</p>
            <p className="mt-4 inline-block rounded-full bg-forest px-3 py-1 text-[11px] uppercase tracking-wider text-cream">
              Status: {ORDER_STATUS_LABEL[order.status] ?? order.status}
            </p>
          </HexBadge>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-[1.3fr_1fr]">
          <Frame tone="light" n={18} innerClassName="p-6">
            <h2 className="text-[30px] leading-none">Items</h2>
            <ul className="mt-4 divide-y divide-dashed divide-forest/25 text-[13px]">
              {order.items.map((i) => (
                <li key={i.id} className="flex justify-between gap-4 py-2.5">
                  <span>
                    {i.productName} <span className="text-forest/60">({i.variantLabel})</span> × {i.quantity}
                  </span>
                  <span className="shrink-0">{formatPrice(i.lineTotal)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1.5 border-t-[1.5px] border-forest/30 pt-3 text-[13px]">
              <div className="flex justify-between">
                <dt>Subtotal</dt>
                <dd>{formatPrice(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Delivery</dt>
                <dd>{order.deliveryFee > 0 ? formatPrice(order.deliveryFee) : "To be confirmed"}</dd>
              </div>
              <div className="flex items-baseline justify-between pt-1">
                <dt className="eyebrow">Total</dt>
                <dd className="display text-[30px]">{formatPrice(order.total)}</dd>
              </div>
            </dl>
          </Frame>
          <Frame tone="light" n={18} innerClassName="p-6 text-[13px]">
            <h2 className="text-[30px] leading-none">Delivery to</h2>
            <address className="mt-4 not-italic leading-relaxed">
              {order.customerName}
              <br />
              {order.addressLine1}
              {order.addressLine2 && (
                <>
                  <br />
                  {order.addressLine2}
                </>
              )}
              <br />
              {order.city}, {order.state} {order.pincode}
            </address>
            <p className="mt-4 text-forest/70">
              Payment: {order.paymentMethod === "cod" ? "Pay on delivery" : "Online (Razorpay)"} — {order.paymentStatus}
            </p>
          </Frame>
        </div>

        <div className="mt-10 text-center text-[13px] text-forest/75">
          <p>
            Questions about your order? Call{" "}
            <a href={`tel:${site.phones[0].replace(/\s/g, "")}`} className="link-underline text-forest">
              {site.phones[0]}
            </a>{" "}
            or email{" "}
            <a href={`mailto:${site.email}?subject=Order%20${order.number}`} className="link-underline text-forest">
              {site.email}
            </a>{" "}
            with your order number.
          </p>
          <p className="mt-2 text-[12px] text-forest/55">Keep this page&apos;s link to view your order again.</p>
          <Link href="/shop" className="btn mt-8">
            Continue shopping
          </Link>
        </div>
      </div>
    </div>
  );
}
