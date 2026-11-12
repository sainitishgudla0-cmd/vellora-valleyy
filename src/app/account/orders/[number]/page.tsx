import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentCustomer } from "@/lib/auth/customer";
import { getOrder } from "@/lib/account/orders";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { formatPrice } from "@/lib/format";
import { SignIn } from "@/components/account/SignIn";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const SHIPMENT_LABEL: Record<string, string> = { created: "Shipment created", picked_up: "Picked up", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered", failed: "Delivery attempt failed", returned: "Returned to us" };

/** One of the signed-in customer's own orders. Anyone else's number is a 404, exactly like an unknown one. */
export default async function AccountOrderPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const me = await currentCustomer();
  if (!me) return <SignIn />;
  const o = await getOrder(me.customerId, number);
  if (!o) notFound();
  return (
    <div className="container-site py-10 md:py-14">
      <Link href="/account" className="link-underline text-[13px]">
        ← Your orders
      </Link>
      <h1 className="text-display-sm mt-3">Order {o.number}</h1>
      <p className="mt-1 text-[13px] text-forest/70" data-testid="order-status">
        {ORDER_STATUS_LABEL[o.status] ?? o.status} · placed {o.createdAt.toLocaleDateString("en-IN")}
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <h2 className="mb-2 text-[15px] font-medium">Items</h2>
          <ul className="divide-y divide-dashed divide-forest/25 text-[13px]">
            {o.items.map((i, k) => (
              <li key={k} className="flex justify-between gap-4 py-2.5">
                <span>
                  {i.productName} <span className="text-forest/60">({i.variantLabel})</span> × {i.quantity}
                </span>
                <span className="shrink-0">{formatPrice(i.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t-[1.5px] border-forest/30 pt-3 text-[13px]">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatPrice(o.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Delivery</dt>
              <dd>{o.deliveryFee > 0 ? formatPrice(o.deliveryFee) : "—"}</dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Total</dt>
              <dd>{formatPrice(o.total)}</dd>
            </div>
          </dl>
          {o.invoice && (
            <p className="mt-5">
              <a href={`/api/account/orders/${o.number}/invoice`} className="btn btn-sm" data-testid="invoice-download">
                Download tax invoice {o.invoice.number}
              </a>
            </p>
          )}
        </section>

        <aside className="space-y-6 text-[13px]">
          <section>
            <h2 className="mb-2 text-[15px] font-medium">Delivery to</h2>
            <address className="not-italic leading-relaxed">
              {o.shipping.name}
              <br />
              {o.shipping.line1}
              {o.shipping.line2 ? `, ${o.shipping.line2}` : ""}
              <br />
              {o.shipping.city}, {o.shipping.state} {o.shipping.pincode}
            </address>
          </section>
          {o.shipments.length > 0 && (
            <section>
              <h2 className="mb-2 text-[15px] font-medium">Tracking</h2>
              {o.shipments.map((s) => (
                <div key={s.awb} className="mb-3" data-testid="shipment">
                  <p>
                    {s.courier} · {s.awb} · <span className="font-medium">{SHIPMENT_LABEL[s.status] ?? s.status}</span>
                  </p>
                  {s.trackingUrl && (
                    <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer" className="link-underline">
                      Track shipment
                    </a>
                  )}
                </div>
              ))}
            </section>
          )}
          <section>
            <h2 className="mb-2 text-[15px] font-medium">History</h2>
            <ol className="space-y-1 text-forest/75">
              {o.history.map((h, k) => (
                <li key={k}>
                  {ORDER_STATUS_LABEL[h.to] ?? h.to} · {h.at.toLocaleString("en-IN")}
                </li>
              ))}
              {o.history.length === 0 && <li>Order received {o.createdAt.toLocaleString("en-IN")}</li>}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
