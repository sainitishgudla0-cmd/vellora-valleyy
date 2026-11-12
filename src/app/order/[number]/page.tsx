import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { site } from "@/config/site";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { formatPrice } from "@/lib/format";
import { MOCK_PAYMENT_LABEL } from "@/lib/payments/labels";
import { Frame, HexBadge } from "@/components/ui/Ornaments";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };
export const dynamic = "force-dynamic";

const SHIPMENT_LABEL: Record<string, string> = { created: "Shipment created", picked_up: "Picked up", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered", failed: "Delivery attempt failed", returned: "Returned to us" };

export default async function OrderPage(props: { params: Promise<{ number: string }>; searchParams: Promise<{ t?: string; payment?: string }> }) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const order = await db.order.findUnique({ where: { number: params.number }, include: { items: true, shipments: { orderBy: { createdAt: "asc" }, select: { courier: true, awb: true, trackingUrl: true, status: true } }, invoice: { select: { number: true } } } });
  // the access token keeps order details private to the person who placed it
  if (!order || !searchParams.t || searchParams.t !== order.accessToken) notFound();

  const mock = order.paymentMode === "mock";
  const paid = order.paymentStatus === "paid";
  const awaitingPayment = order.status === "awaiting_payment" || searchParams.payment === "failed";

  const headline = paid && mock ? "Mock payment recorded." : paid ? "Thank you! Payment received." : awaitingPayment ? "Payment not completed" : "Thank you! Order request received.";
  const message = paid && mock
    ? `Order ${order.number} was marked paid by the mock payment provider (${MOCK_PAYMENT_LABEL}). It is a test order and will not be fulfilled.`
    : paid
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
            {mock && <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-forest">{MOCK_PAYMENT_LABEL}</p>}
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
              Payment: {order.paymentMethod === "cod" ? "Pay on delivery" : mock ? "Online (mock)" : "Online (Razorpay)"} — {order.paymentStatus}
              {mock && <span className="ml-1 font-medium text-forest">· {MOCK_PAYMENT_LABEL}</span>}
            </p>
          </Frame>
        </div>

        {(order.shipments.length > 0 || order.invoice) && (
          <div className="mt-6">
            <Frame tone="light" n={18} innerClassName="p-6 text-[13px]">
              <h2 className="text-[30px] leading-none">{order.shipments.length > 0 ? "Tracking" : "Invoice"}</h2>
              {order.shipments.map((sh) => (
                <p key={`${sh.courier}-${sh.awb}`} className="mt-4 leading-relaxed" data-testid="shipment">
                  {sh.courier} · tracking number <span className="font-medium">{sh.awb}</span> · {SHIPMENT_LABEL[sh.status] ?? sh.status}
                  {sh.trackingUrl && (
                    <>
                      {" "}
                      <a href={sh.trackingUrl} target="_blank" rel="noopener noreferrer" className="link-underline text-forest">
                        Track shipment
                      </a>
                    </>
                  )}
                </p>
              ))}
              {order.invoice && (
                <p className="mt-4">
                  <a href={`/api/orders/${order.number}/invoice?t=${encodeURIComponent(searchParams.t)}`} className="link-underline text-forest" data-testid="invoice-link">
                    Download tax invoice {order.invoice.number} (PDF)
                  </a>
                </p>
              )}
            </Frame>
          </div>
        )}

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
