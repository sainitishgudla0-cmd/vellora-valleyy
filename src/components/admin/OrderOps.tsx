"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminApi, errorText } from "./api";

/**
 * Admin order operations (M11 P4). Thin forms over the existing, audited APIs; the server decides everything
 * (permissions, state machine, refund ledger, shipment graph). Each control shows the API's own message on failure.
 */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => ReturnType<typeof adminApi>, success: string) => {
    setBusy(true);
    setMsg(null);
    const r = await fn();
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: success } : { ok: false, text: errorText(r) });
    if (r.ok) router.refresh();
    return r;
  };
  const note = msg && (
    <p role="status" className={msg.ok ? "mt-2 text-[12.5px] text-leaf" : "field-error"}>
      {msg.text}
    </p>
  );
  return { busy, run, note };
}

const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function RefundForm({ orderId, payments }: { orderId: string; payments: { id: string; label: string; refundablePaise: number }[] }) {
  const { busy, run, note } = useAction();
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newKey);
  const selected = payments.find((p) => p.id === paymentId);
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px] sm:items-end"
      data-testid="refund-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const paise = amount.trim() ? Math.round(Number(amount) * 100) : undefined;
        if (paise !== undefined && (!Number.isFinite(paise) || paise <= 0)) return;
        if (!window.confirm(`Refund ${amount.trim() ? `₹${amount}` : "the full remaining balance"} to the customer through the payment gateway? This moves real money.`)) return;
        const r = await run(() => adminApi("POST", `/api/admin/orders/${orderId}/refunds`, { reason, requestKey: key, paymentId, ...(paise ? { amountPaise: paise } : {}) }), "Refund requested. Its status updates from the gateway.");
        if (r.ok || r.status === 409) setKey(newKey()); // a new attempt is a new request; a 5xx keeps the key so a retry cannot refund twice
      }}
    >
      {payments.length > 1 && (
        <label className="text-[12.5px] sm:col-span-2">
          Payment
          <select className="input mt-1" value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="text-[12.5px]">
        Reason (kept on the refund record)
        <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
      </label>
      <label className="text-[12.5px]">
        Amount ₹ (empty = all)
        <input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={selected ? (selected.refundablePaise / 100).toFixed(2) : ""} />
      </label>
      <button className="btn sm:col-span-2 sm:justify-self-start" disabled={busy || !paymentId}>
        {busy ? "Requesting…" : "Refund through the gateway"}
      </button>
      <div className="sm:col-span-2">{note}</div>
    </form>
  );
}

const METHODS: [string, string][] = [
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["bank_transfer", "Bank transfer"],
  ["cheque", "Cheque"],
  ["card_on_delivery", "Card on delivery"],
];

/**
 * Pay-on-delivery collection recorded with the attested full amount, method and external reference (M11 P1-T2; request-only
 * orders only, `payments:record`; the API refuses everything else). The record cannot be changed afterwards.
 */
export function ManualPaymentForm({ orderId, amountPaise }: { orderId: string; amountPaise: number }) {
  const { busy, run, note } = useAction();
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-2 sm:items-end"
      data-testid="manual-payment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const paise = Math.round(Number(amount) * 100);
        if (!window.confirm(`Record ₹${amount} received by ${METHODS.find((m) => m[0] === method)?.[1] ?? method} (ref ${reference})? This record cannot be changed later.`)) return;
        await run(() => adminApi("PATCH", `/api/admin/orders/${orderId}`, { paymentStatus: "paid", reason, paymentReference: reference, offline: { amountPaise: paise, method } }), "Payment recorded.");
      }}
    >
      <label className="text-[12.5px]">
        Amount received ₹ (order total ₹{(amountPaise / 100).toFixed(2)})
        <input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label className="text-[12.5px]">
        Method
        <select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value)} required>
          <option value="">Choose…</option>
          {METHODS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12.5px]">
        Receipt / UTR / reference
        <input className="input mt-1" value={reference} onChange={(e) => setReference(e.target.value)} minLength={3} maxLength={80} required />
      </label>
      <label className="text-[12.5px]">
        How it was collected
        <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
      </label>
      <button className="btn sm:justify-self-start" disabled={busy}>
        {busy ? "Saving…" : "Record payment received"}
      </button>
      <div className="sm:col-span-2">{note}</div>
    </form>
  );
}

export function ShipmentCreateForm({ orderId }: { orderId: string }) {
  const { busy, run, note } = useAction();
  const [courier, setCourier] = useState("");
  const [awb, setAwb] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-3 sm:items-end"
      data-testid="shipment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => adminApi("POST", `/api/admin/orders/${orderId}/shipments`, { courier, awb, ...(trackingUrl.trim() ? { trackingUrl: trackingUrl.trim() } : {}) }), "Shipment added.");
        if (r.ok) {
          setCourier("");
          setAwb("");
          setTrackingUrl("");
        }
      }}
    >
      <label className="text-[12.5px]">
        Courier
        <input className="input mt-1" value={courier} onChange={(e) => setCourier(e.target.value)} required maxLength={80} />
      </label>
      <label className="text-[12.5px]">
        AWB / tracking number
        <input className="input mt-1" value={awb} onChange={(e) => setAwb(e.target.value)} required maxLength={40} />
      </label>
      <label className="text-[12.5px]">
        Tracking link (https, optional)
        <input className="input mt-1" type="url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} />
      </label>
      <button className="btn sm:justify-self-start" disabled={busy}>
        {busy ? "Adding…" : "Add shipment"}
      </button>
      <div className="sm:col-span-3">{note}</div>
    </form>
  );
}

export function ShipmentStatusSelect({ id, status, next }: { id: string; status: string; next: string[] }) {
  const { busy, run, note } = useAction();
  if (next.length === 0) return <span className="text-[12.5px] text-forest/60">{status.replace(/_/g, " ")}</span>;
  return (
    <div>
      <select
        aria-label="Shipment status"
        className="input w-auto py-1 text-[12.5px]"
        value={status}
        disabled={busy}
        onChange={(e) => run(() => adminApi("PATCH", `/api/admin/shipments/${id}`, { status: e.target.value }), "Shipment updated.")}
      >
        <option value={status}>{status.replace(/_/g, " ")}</option>
        {next.map((s) => (
          <option key={s} value={s}>
            → {s.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      {note}
    </div>
  );
}

export function IssueInvoiceButton({ orderId }: { orderId: string }) {
  const { busy, run, note } = useAction();
  const [missing, setMissing] = useState<string[]>([]);
  return (
    <div>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          const r = await run(() => adminApi("POST", `/api/admin/orders/${orderId}/invoice`), "Invoice issued.");
          setMissing(!r.ok && Array.isArray(r.data.detail) ? (r.data.detail as unknown[]).map(String) : []);
        }}
      >
        {busy ? "Issuing…" : "Issue tax invoice"}
      </button>
      {note}
      {missing.length > 0 && <p className="text-[12.5px] text-forest/70">Missing: {missing.join(", ")} (Settings → GST rates, or the seller GSTIN).</p>}
    </div>
  );
}

export function OutboxRetryButton({ id }: { id: string }) {
  const { busy, run, note } = useAction();
  return (
    <div>
      <button className="link-underline text-[12.5px]" disabled={busy} onClick={() => run(() => adminApi("POST", `/api/admin/outbox/${id}/retry`), "Queued again.")}>
        Retry
      </button>
      {note}
    </div>
  );
}

/** Start counting stock for a variant, or adjust its count (inventory:write). Every change needs a reason (ledger). */
export function StockEditor({ id, tracked, stock, reserved }: { id: string; tracked: boolean; stock: number; reserved: number }) {
  const { busy, run, note } = useAction();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-[12.5px]"
      onSubmit={async (e) => {
        e.preventDefault();
        const d = Number(delta);
        if (!tracked) {
          await run(() => adminApi("PATCH", `/api/admin/variants/${id}`, { trackInventory: true, reason, ...(Number.isInteger(d) && d > 0 ? { stockAdjust: { delta: d, reason } } : {}) }), "Stock tracking started.");
        } else {
          if (!Number.isInteger(d) || d === 0) return;
          await run(() => adminApi("PATCH", `/api/admin/variants/${id}`, { stockAdjust: { delta: d, reason } }), "Stock adjusted.");
        }
        setDelta("");
        setReason("");
      }}
    >
      <span className="min-w-[110px]" data-testid="stock-summary">
        {tracked ? `${stock - reserved} available (${stock} on hand, ${reserved} held)` : "not tracked"}
      </span>
      <input aria-label={tracked ? "Change in units (+/-)" : "Opening stock"} className="input w-[90px] py-1" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder={tracked ? "+/- units" : "units"} required={tracked} />
      <input aria-label="Reason" className="input w-[180px] py-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" minLength={3} maxLength={200} required />
      <button className="link-underline" disabled={busy}>
        {tracked ? "Adjust" : "Start tracking"}
      </button>
      <div className="w-full">{note}</div>
    </form>
  );
}
