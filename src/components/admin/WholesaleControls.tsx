"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminApi, errorText } from "./api";

/**
 * Wholesale administration (M11 P4): thin forms over the audited wholesale admin API (ADR 0014). Prices, terms and limits
 * are typed in by staff; nothing is suggested. The server enforces the account graph, MRP caps and credit rules.
 */
function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (method: string, url: string, body: unknown, success: string) => {
    setBusy(true);
    setMsg(null);
    const r = await adminApi(method, url, body);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: success } : { ok: false, text: errorText(r) });
    if (r.ok) router.refresh();
    return r;
  };
  const note = msg && (
    <p role="status" className={msg.ok ? "mt-1 text-[12px] text-leaf" : "field-error"}>
      {msg.text}
    </p>
  );
  return { busy, act, note };
}

const LABEL: Record<string, string> = { approved: "Approve", rejected: "Reject", suspended: "Suspend", closed: "Close" };

export function AccountActions({ id, next, priceLists, priceListId, paymentTerms, creditLimitPaise }: { id: string; next: string[]; priceLists: { id: string; name: string }[]; priceListId: string | null; paymentTerms: string; creditLimitPaise: number }) {
  const { busy, act, note } = useAct();
  const [list, setList] = useState(priceListId ?? "");
  const [terms, setTerms] = useState(paymentTerms);
  const [limit, setLimit] = useState(creditLimitPaise ? String(creditLimitPaise / 100) : "");
  const terms_ = () => ({ ...(list ? { priceListId: list } : {}), paymentTerms: terms, ...(limit.trim() ? { creditLimit: Math.round(Number(limit) * 100) } : {}) });
  return (
    <div className="space-y-2 text-[12.5px]" data-testid="account-actions">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          Price list
          <select className="input mt-1 py-1" value={list} onChange={(e) => setList(e.target.value)}>
            <option value="">Retail prices</option>
            {priceLists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Terms
          <select className="input mt-1 py-1" value={terms} onChange={(e) => setTerms(e.target.value)}>
            <option value="prepaid">Prepaid</option>
            <option value="credit">Credit</option>
          </select>
        </label>
        <label>
          Credit limit ₹
          <input className="input mt-1 w-[110px] py-1" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
        <button className="link-underline" disabled={busy} onClick={() => act("PATCH", `/api/admin/wholesale/accounts/${id}`, terms_(), "Saved.")}>
          Save terms
        </button>
      </div>
      <div className="flex flex-wrap gap-3">
        {next.map((s) => (
          <button key={s} className="link-underline" disabled={busy} onClick={() => (s === "approved" ? act("PATCH", `/api/admin/wholesale/accounts/${id}`, { status: s, ...terms_() }, "Approved.") : window.confirm(`${LABEL[s] ?? s} this account?`) && act("PATCH", `/api/admin/wholesale/accounts/${id}`, { status: s }, "Updated."))}>
            {LABEL[s] ?? s}
          </button>
        ))}
      </div>
      {note}
    </div>
  );
}

export function QuotePricing({ id, items }: { id: string; items: { variantId: string; label: string; quantity: number; mrpPaise: number }[] }) {
  const { busy, act, note } = useAct();
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [fee, setFee] = useState("");
  const [days, setDays] = useState("7");
  return (
    <form
      className="mt-2 space-y-2 text-[12.5px]"
      data-testid="quote-pricing"
      onSubmit={async (e) => {
        e.preventDefault();
        await act(
          "PATCH",
          `/api/admin/quotes/${id}`,
          { action: "quote", items: items.map((i) => ({ variantId: i.variantId, unitPrice: Math.round(Number(prices[i.variantId]) * 100) })), ...(fee.trim() ? { deliveryFee: Math.round(Number(fee) * 100) } : {}), validDays: Number(days) },
          "Quote sent to the buyer.",
        );
      }}
    >
      {items.map((i) => (
        <label key={i.variantId} className="flex flex-wrap items-center gap-2">
          <span className="min-w-[220px]">
            {i.quantity} × {i.label} (MRP ₹{(i.mrpPaise / 100).toFixed(2)})
          </span>
          <input aria-label={`Unit price for ${i.label}`} className="input w-[110px] py-1" inputMode="decimal" value={prices[i.variantId] ?? ""} onChange={(e) => setPrices({ ...prices, [i.variantId]: e.target.value })} placeholder="₹ per unit" required />
        </label>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <label>
          Delivery fee ₹
          <input className="input mt-1 w-[110px] py-1" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label>
          Valid for (days)
          <input className="input mt-1 w-[80px] py-1" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button className="btn" disabled={busy}>
          {busy ? "Sending…" : "Send quote"}
        </button>
        <button type="button" className="link-underline" disabled={busy} onClick={() => window.confirm("Reject this quote request?") && act("PATCH", `/api/admin/quotes/${id}`, { action: "reject" }, "Rejected.")}>
          Reject
        </button>
      </div>
      {note}
    </form>
  );
}
