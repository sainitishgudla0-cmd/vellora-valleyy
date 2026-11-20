import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { adminConfigured } from "@/lib/admin-auth";
import { currentAdmin, legacyLoginEnabled } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/format";
import { listOrderRefunds } from "@/lib/payments/refunds";
import { SHIPMENT_TRANSITIONS, SHIPPABLE_ORDER_STATUSES } from "@/lib/shipping/shipments";
import { AdminLogin, OrderStatusSelect } from "@/components/admin/AdminControls";
import { IssueInvoiceButton, ManualPaymentForm, RefundForm, ShipmentCreateForm, ShipmentStatusSelect } from "@/components/admin/OrderOps";

export const metadata: Metadata = { title: "Order · Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const when = (d: Date) => d.toLocaleString("en-IN");
const label = (s: string) => s.replace(/_/g, " ");

/**
 * One order for staff (M11 P4): history, payments and refunds, shipments, invoice, with the actions each role may take.
 * Every action goes through the existing audited API; this page only reads.
 */
export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  if (!adminConfigured()) notFound();
  const admin = await currentAdmin();
  if (!admin) return <AdminLogin emailRequired={!legacyLoginEnabled()} />;
  const { id } = await params;
  const order = await db.order.findUnique({
    where: { id },
    include: {
      items: true,
      events: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
      shipments: { orderBy: { createdAt: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } } },
      invoice: true,
    },
  });
  if (!order) notFound();
  const ledger = await listOrderRefunds(order.id);
  const refundable = (ledger?.payments ?? []).filter((p) => p.refundablePaise > 0);
  const requestOnlyUnpaid = order.paymentMode === "request_only" && order.paymentStatus === "unpaid" && order.payments.some((p) => p.provider === "request_only" && p.status === "unpaid") && order.status !== "cancelled";
  const shippable = (SHIPPABLE_ORDER_STATUSES as readonly string[]).includes(order.status);

  return (
    <div className="container-site py-10">
      <Link href="/admin?tab=orders" className="link-underline text-[13px]">
        ← All orders
      </Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-leaf">Order</p>
          <h1 className="text-display-sm" data-testid="admin-order-number">
            {order.number}
          </h1>
          <p className="mt-1 text-[13px] text-forest/60">
            Placed {when(order.createdAt)} · {order.paymentMethod === "cod" ? "Pay on delivery" : "Online payment"} · payment {label(order.paymentStatus)}
          </p>
        </div>
        {admin.can("orders:write") ? <OrderStatusSelect id={order.id} status={order.status} /> : <span className="text-[13px]">{label(order.status)}</span>}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-[12px] border border-forest/15 bg-cream-light p-5 text-[13px]" aria-labelledby="h-customer">
          <h2 id="h-customer" className="text-[15px] font-medium">
            Customer and delivery
          </h2>
          <p className="mt-2">
            {order.customerName} · <a href={`tel:${order.phone}`} className="underline">{order.phone}</a> · {order.email}
          </p>
          <p className="text-forest/70">
            {order.addressLine1}
            {order.addressLine2 ? `, ${order.addressLine2}` : ""}, {order.city}, {order.state} {order.pincode}
          </p>
          {order.notes && <p className="mt-1 italic text-forest/70">“{order.notes}”</p>}
          <table className="mt-4 w-full text-left text-[12.5px]">
            <tbody className="divide-y divide-forest/10">
              {order.items.map((i) => (
                <tr key={i.id}>
                  <td className="py-1.5 pr-2">
                    {i.quantity} × {i.productName} ({i.variantLabel})
                  </td>
                  <td className="py-1.5 text-right">{formatPrice(i.lineTotal)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-2 text-forest/70">Delivery</td>
                <td className="py-1.5 text-right">{formatPrice(order.deliveryFee)}</td>
              </tr>
              <tr className="font-medium">
                <td className="py-1.5 pr-2">Total</td>
                <td className="py-1.5 text-right">{formatPrice(order.total)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="rounded-[12px] border border-forest/15 bg-cream-light p-5 text-[13px]" aria-labelledby="h-payments">
          <h2 id="h-payments" className="text-[15px] font-medium">
            Payments and refunds
          </h2>
          {order.payments.length === 0 ? (
            <p className="mt-2 text-forest/60">No payment record.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {order.payments.map((p) => (
                <li key={p.id}>
                  {p.provider === "request_only" ? "Pay on delivery" : p.provider === "mock" ? "Mock (no money)" : "Razorpay"} · {formatPrice(p.amount)} · <span className="font-medium">{label(p.status)}</span>
                  {p.manualReference && (
                    <span className="text-forest/60">
                      {" "}
                      · ref {p.manualReference}
                      {p.manualMethod ? ` · ${p.manualMethod.replace(/_/g, " ")}` : ""}
                      {p.manualRecordedAt ? ` · recorded ${when(p.manualRecordedAt)}` : ""}
                    </span>
                  )}
                  {p.needsReconciliation && <span className="ml-1 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">{label(p.reconcileReason ?? "awaiting reconciliation")}</span>}
                </li>
              ))}
            </ul>
          )}
          {(ledger?.refunds.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-1 border-t border-forest/10 pt-3" data-testid="refund-list">
              {ledger!.refunds.map((r) => (
                <li key={r.id}>
                  Refund {formatPrice(r.amountPaise)} · <span className="font-medium">{r.status}</span> · {r.source === "gateway" ? "made in the gateway dashboard" : "requested here"} · {when(r.createdAt)}
                  {r.failureCode && <span className="text-forest/60"> · {label(r.failureCode)}</span>}
                </li>
              ))}
            </ul>
          )}
          {requestOnlyUnpaid && admin.can("payments:record") && (
            <div className="mt-4 border-t border-forest/10 pt-3">
              <p className="font-medium">Record a pay-on-delivery collection</p>
              <ManualPaymentForm orderId={order.id} amountPaise={order.payments.find((p) => p.provider === "request_only" && p.status === "unpaid")!.amount} />
            </div>
          )}
          {requestOnlyUnpaid && !admin.can("payments:record") && <p className="mt-3 text-[12.5px] text-forest/60">Payments received on delivery are recorded by an owner account.</p>}
          {refundable.length > 0 && admin.can("refunds:write") && (
            <div className="mt-4 border-t border-forest/10 pt-3">
              <p className="font-medium">Refund</p>
              <RefundForm orderId={order.id} payments={refundable.map((p) => ({ id: p.paymentId, label: `${formatPrice(p.amountPaise)} captured · ${formatPrice(p.refundablePaise)} refundable`, refundablePaise: p.refundablePaise }))} />
            </div>
          )}
          {refundable.length > 0 && !admin.can("refunds:write") && <p className="mt-3 text-[12.5px] text-forest/60">Refunds are made by an owner account.</p>}
        </section>

        {admin.can("fulfilment:read") && (
        <section className="rounded-[12px] border border-forest/15 bg-cream-light p-5 text-[13px]" aria-labelledby="h-shipments">
          <h2 id="h-shipments" className="text-[15px] font-medium">
            Shipments
          </h2>
          {order.shipments.length === 0 && <p className="mt-2 text-forest/60">No shipment yet.</p>}
          <ul className="mt-2 space-y-3">
            {order.shipments.map((s) => (
              <li key={s.id} data-testid="shipment-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {s.courier} · AWB {s.awb}
                    {s.trackingUrl && (
                      <>
                        {" · "}
                        <a href={s.trackingUrl} className="underline" target="_blank" rel="noreferrer">
                          track
                        </a>
                      </>
                    )}
                  </span>
                  {admin.can("fulfilment:write") ? <ShipmentStatusSelect id={s.id} status={s.status} next={[...SHIPMENT_TRANSITIONS[s.status]]} /> : <span>{label(s.status)}</span>}
                </div>
                <p className="text-[12px] text-forest/60">{s.events.map((e) => `${label(e.status)} ${when(e.createdAt)}`).join(" · ")}</p>
              </li>
            ))}
          </ul>
          {shippable && admin.can("fulfilment:write") && <ShipmentCreateForm orderId={order.id} />}
          {!shippable && <p className="mt-2 text-[12.5px] text-forest/60">Shipments can be added once the order is confirmed or paid.</p>}
        </section>
        )}

        {admin.can("fulfilment:read") && (
        <section className="rounded-[12px] border border-forest/15 bg-cream-light p-5 text-[13px]" aria-labelledby="h-invoice">
          <h2 id="h-invoice" className="text-[15px] font-medium">
            Tax invoice
          </h2>
          {order.invoice ? (
            <p className="mt-2" data-testid="invoice-issued">
              {order.invoice.number} · issued {when(order.invoice.issuedAt)} · {formatPrice(order.invoice.total)} ·{" "}
              <a href={`/api/admin/invoices/${order.invoice.id}`} className="underline">
                PDF
              </a>
            </p>
          ) : admin.can("fulfilment:write") && order.status !== "cancelled" ? (
            <div className="mt-2">
              <p className="mb-2 text-forest/60">Not issued. Issuing needs the seller GSTIN and an approved GST rate for every item (see Operations).</p>
              <IssueInvoiceButton orderId={order.id} />
            </div>
          ) : (
            <p className="mt-2 text-forest/60">Not issued.</p>
          )}
        </section>
        )}
      </div>

      <section className="mt-8" aria-labelledby="h-history">
        <h2 id="h-history" className="text-[15px] font-medium">
          History
        </h2>
        <ol className="mt-3 space-y-1.5 text-[12.5px]" data-testid="order-history">
          {order.events.length === 0 && <li className="text-forest/60">No changes since the order was placed.</li>}
          {order.events.map((e) => (
            <li key={e.id}>
              <span className="text-forest/60">{when(e.createdAt)}</span> · {label(e.fromStatus)} → <span className="font-medium">{label(e.toStatus)}</span>
              {e.toPaymentStatus && (
                <>
                  {" "}
                  · payment {e.fromPaymentStatus ? label(e.fromPaymentStatus) : "—"} → <span className="font-medium">{label(e.toPaymentStatus)}</span>
                </>
              )}
              <span className="text-forest/60">
                {" "}
                · {e.actorType}
                {e.reason ? ` · ${e.reason}` : ""}
                {e.paymentReference ? ` · ref ${e.paymentReference}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
