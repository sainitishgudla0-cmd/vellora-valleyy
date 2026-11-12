"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BUSINESS_INTERESTS, INDIAN_STATES } from "@/lib/validation";
import { formatPrice } from "@/lib/format";
import { api, errorText } from "./api";
import type { AddressView } from "./AccountControls";

/** Wholesale (M6) in the shopper's account: apply, see the status, view your prices, ask for quotes, accept or decline them. All prices are GST-inclusive. */
export interface QuoteView {
  number: string;
  status: string;
  requestNote: string | null;
  buyerNote: string | null;
  validUntil: string | null;
  orderNumber: string | null;
  items: { productName: string; variantLabel: string; quantity: number; unitPrice?: number | null; lineTotal?: number | null }[];
  subtotal?: number | null;
  deliveryFee?: number | null;
  total?: number | null;
}
export interface PriceItem {
  variantId: string;
  product: string;
  label: string;
  retailPrice: number;
  moq: number;
  casePack: number;
  tiers: { minQty: number; unitPrice: number }[];
}
export interface VariantOption {
  id: string;
  label: string;
}

const small = "rounded-full border border-forest/30 px-3 py-1 text-[11px] hover:bg-sage disabled:opacity-50";
const STATUS_TEXT: Record<string, string> = {
  pending: "Your application is being reviewed. We will approve it once we have checked the details.",
  rejected: "Your application was not approved. You can correct the details below and apply again, or call us.",
  suspended: "Your business account is paused. Please contact us.",
  closed: "Your business account has been closed. Please contact us if this is a surprise.",
};
const QUOTE_TEXT: Record<string, string> = { requested: "Waiting for our price", quoted: "Priced: ready for you to accept", accepted: "Accepted", declined: "Declined", expired: "Expired", rejected: "We could not quote this", cancelled: "Cancelled" };

export function BusinessPortal(props: {
  status: string | null;
  account: { companyName: string; gstin: string; paymentTerms: string; creditLimit: number | null } | null;
  prefill: { name: string; phone: string; email: string };
  address: AddressView | null;
  quotes: QuoteView[];
  priceItems: PriceItem[];
  variants: VariantOption[];
}) {
  const { status, account } = props;
  return (
    <div className="space-y-8">
      {status === null || status === "rejected" ? (
        <>
          {status === "rejected" && (
            <p role="status" className="max-w-[620px] rounded-[10px] bg-sage p-4 text-[13px]">
              {STATUS_TEXT.rejected}
            </p>
          )}
          <ApplyForm prefill={props.prefill} />
        </>
      ) : status !== "approved" ? (
        <div role="status" className="max-w-[620px] rounded-[12px] bg-sage p-5 text-[13.5px]" data-testid="business-status">
          <p className="font-medium">
            {account?.companyName} <span className="ml-2 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">{status}</span>
          </p>
          <p className="mt-2 text-forest/80">{STATUS_TEXT[status]}</p>
        </div>
      ) : (
        <>
          <div role="status" className="max-w-[620px] rounded-[12px] bg-sage p-5 text-[13.5px]" data-testid="business-status">
            <p className="font-medium">
              {account?.companyName} <span className="ml-2 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">approved</span>
            </p>
            <p className="mt-1 text-forest/75">
              GSTIN {account?.gstin} · {account?.paymentTerms === "credit" ? `On account (credit limit ${formatPrice(account.creditLimit ?? 0)})` : "Prepaid"}
            </p>
          </div>
          <PriceTable items={props.priceItems} />
          <QuoteRequest variants={props.variants} />
          <Quotes quotes={props.quotes} prefill={props.prefill} address={props.address} />
        </>
      )}
    </div>
  );
}

function ApplyForm({ prefill }: { prefill: { name: string; phone: string } }) {
  const router = useRouter();
  const [f, setF] = useState({ companyName: "", gstin: "", contactName: prefill.name, phone: prefill.phone, interest: "", message: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      aria-label="Apply for a business account"
      className="grid max-w-[620px] gap-3 rounded-[12px] bg-sage p-5 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await api("POST", "/api/business/apply", { companyName: f.companyName, gstin: f.gstin, contactName: f.contactName, phone: f.phone, ...(f.interest ? { interest: f.interest } : {}), ...(f.message.trim() ? { message: f.message } : {}) });
        setBusy(false);
        if (!r.ok) return setErr(errorText(r));
        router.refresh();
      }}
    >
      <h3 className="text-[15px] font-medium sm:col-span-2">Apply for a business account</h3>
      <p className="text-[12.5px] text-forest/70 sm:col-span-2">For distributors, retailers, hotels and caterers. We review every application; once approved you see your own prices and can ask for quotes.</p>
      <div className="sm:col-span-2">
        <label htmlFor="ba-company" className="label">
          Company name
        </label>
        <input id="ba-company" className="input" value={f.companyName} onChange={set("companyName")} required maxLength={120} />
      </div>
      <div>
        <label htmlFor="ba-gstin" className="label">
          GSTIN
        </label>
        <input id="ba-gstin" className="input uppercase" value={f.gstin} onChange={set("gstin")} required maxLength={20} placeholder="15 characters" />
      </div>
      <div>
        <label htmlFor="ba-interest" className="label">
          What do you need? (optional)
        </label>
        <select id="ba-interest" className="input" value={f.interest} onChange={set("interest")}>
          <option value="">Select</option>
          {Object.entries(BUSINESS_INTERESTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="ba-contact" className="label">
          Contact person
        </label>
        <input id="ba-contact" className="input" value={f.contactName} onChange={set("contactName")} required maxLength={80} />
      </div>
      <div>
        <label htmlFor="ba-phone" className="label">
          Mobile number
        </label>
        <input id="ba-phone" className="input" value={f.phone} onChange={set("phone")} required inputMode="tel" />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="ba-msg" className="label">
          Anything else? (optional)
        </label>
        <textarea id="ba-msg" className="input resize-none" rows={2} value={f.message} onChange={set("message")} maxLength={1000} />
      </div>
      {err && <p className="field-error sm:col-span-2">{err}</p>}
      <button className="btn sm:col-span-2" disabled={busy}>
        {busy ? "Sending…" : "Send application"}
      </button>
    </form>
  );
}

function PriceTable({ items }: { items: PriceItem[] }) {
  return (
    <section>
      <h3 className="mb-2 text-[15px] font-medium">Your prices (inclusive of GST)</h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-forest/60">No special prices are set up for your account yet. You can still ask for a quote; otherwise retail prices apply.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wider text-forest/60">
              <tr>
                <th className="py-2 pr-3">Product</th>
                <th className="py-2 pr-3">Retail</th>
                <th className="py-2 pr-3">Order rules</th>
                <th className="py-2">Your price per pack</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-forest/10">
              {items.map((i) => (
                <tr key={i.variantId} data-testid="price-row">
                  <td className="py-2.5 pr-3">
                    {i.product} <span className="text-forest/60">({i.label})</span>
                  </td>
                  <td className="py-2.5 pr-3">{formatPrice(i.retailPrice)}</td>
                  <td className="py-2.5 pr-3 text-forest/70">{i.moq > 1 || i.casePack > 1 ? `Min ${i.moq}${i.casePack > 1 ? `, in cases of ${i.casePack}` : ""}` : "—"}</td>
                  <td className="py-2.5">{i.tiers.map((t) => `${formatPrice(t.unitPrice)} from ${t.minQty}`).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuoteRequest({ variants }: { variants: VariantOption[] }) {
  const router = useRouter();
  const [rows, setRows] = useState([{ variantId: "", quantity: "" }]);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      aria-label="Request a quote"
      className="max-w-[620px] rounded-[12px] bg-sage p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const items = rows.filter((r) => r.variantId).map((r) => ({ variantId: r.variantId, quantity: Number(r.quantity) }));
        const r = await api("POST", "/api/business/quotes", { items, ...(note.trim() ? { note } : {}) });
        setBusy(false);
        if (!r.ok) return setErr(errorText(r));
        setRows([{ variantId: "", quantity: "" }]);
        setNote("");
        router.refresh();
      }}
    >
      <h3 className="text-[15px] font-medium">Ask for a quote</h3>
      <p className="mt-1 text-[12.5px] text-forest/70">Choose products and quantities. We will send you a price you can accept.</p>
      {rows.map((row, i) => (
        <div key={i} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor={`qr-v-${i}`} className="label">
              Product
            </label>
            <select id={`qr-v-${i}`} className="input" value={row.variantId} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, variantId: e.target.value } : r)))}>
              <option value="">Select a product</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div className="w-28">
            <label htmlFor={`qr-q-${i}`} className="label">
              Quantity
            </label>
            <input id={`qr-q-${i}`} className="input" inputMode="numeric" value={row.quantity} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, quantity: e.target.value.replace(/\D/g, "") } : r)))} />
          </div>
        </div>
      ))}
      <button type="button" className={`${small} mt-3`} onClick={() => setRows([...rows, { variantId: "", quantity: "" }])}>
        Add another product
      </button>
      <label htmlFor="qr-note" className="label mt-4">
        Note (optional)
      </label>
      <input id="qr-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      {err && <p className="field-error">{err}</p>}
      <button className="btn mt-4" disabled={busy}>
        {busy ? "Sending…" : "Request quote"}
      </button>
    </form>
  );
}

function Quotes({ quotes, prefill, address }: { quotes: QuoteView[]; prefill: { name: string; phone: string; email: string }; address: AddressView | null }) {
  return (
    <section>
      <h3 className="mb-2 text-[15px] font-medium">Your quotes</h3>
      {quotes.length === 0 && <p className="text-[13px] text-forest/60">No quotes yet.</p>}
      <div className="space-y-3">
        {quotes.map((q) => (
          <QuoteCard key={q.number} q={q} prefill={prefill} address={address} />
        ))}
      </div>
    </section>
  );
}

function QuoteCard({ q, prefill, address }: { q: QuoteView; prefill: { name: string; phone: string; email: string }; address: AddressView | null }) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [f, setF] = useState({ customerName: address?.name ?? prefill.name, email: prefill.email, phone: address?.phone ?? prefill.phone, addressLine1: address?.line1 ?? "", addressLine2: address?.line2 ?? "", city: address?.city ?? "", state: address?.state ?? "", pincode: address?.pincode ?? "", notes: "" });
  const [err, setErr] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ number: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const act = async (path: string, method: "POST" | "DELETE") => {
    setErr(null);
    const r = await api(method, path, method === "POST" ? {} : undefined);
    if (!r.ok) return setErr(errorText(r));
    router.refresh();
  };

  return (
    <article className="rounded-[12px] border border-forest/15 bg-cream-light p-4 text-[13px]" data-testid="quote" data-number={q.number}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {q.number} <span className="ml-2 rounded-full bg-sage px-2 py-0.5 text-[10px] uppercase tracking-wider">{QUOTE_TEXT[q.status] ?? q.status}</span>
        </p>
        {q.validUntil && q.status === "quoted" && <p className="text-[12px] text-forest/60">Valid until {new Date(q.validUntil).toLocaleDateString("en-IN")}</p>}
      </div>
      <ul className="mt-2 text-forest/80">
        {q.items.map((i, k) => (
          <li key={k}>
            {i.quantity} × {i.productName} ({i.variantLabel}){i.unitPrice != null ? ` — ${formatPrice(i.unitPrice)} each` : ""}
          </li>
        ))}
      </ul>
      {q.total != null && (
        <p className="mt-2 font-medium" data-testid="quote-total">
          Total {formatPrice(q.total)} <span className="font-normal text-forest/60">(incl. GST{q.deliveryFee ? `, delivery ${formatPrice(q.deliveryFee)}` : ""})</span>
        </p>
      )}
      {q.buyerNote && <p className="mt-1 italic text-forest/70">“{q.buyerNote}”</p>}
      {q.orderNumber && <p className="mt-2 text-forest/70">Order {q.orderNumber} was created from this quote.</p>}
      {placed && (
        <p role="status" className="mt-2 text-leaf">
          Order placed.{" "}
          <Link className="link-underline" href={`/order/${placed.number}?t=${encodeURIComponent(placed.token)}`}>
            View order {placed.number}
          </Link>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {q.status === "quoted" && !accepting && (
          <>
            <button className="btn btn-sm" onClick={() => setAccepting(true)}>
              Accept this quote
            </button>
            <button className={small} onClick={() => act(`/api/business/quotes/${q.number}/decline`, "POST")}>
              Decline
            </button>
          </>
        )}
        {q.status === "requested" && (
          <button className={small} onClick={() => act(`/api/business/quotes/${q.number}`, "DELETE")}>
            Withdraw request
          </button>
        )}
      </div>
      {accepting && (
        <form
          aria-label={`Accept quote ${q.number}`}
          className="mt-3 grid gap-3 rounded-[10px] bg-sage p-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            const r = await api("POST", `/api/business/quotes/${q.number}/accept`, { ...f, addressLine2: f.addressLine2 || "", notes: f.notes || "" });
            setBusy(false);
            if (!r.ok) return setErr(errorText(r));
            setPlaced({ number: r.data.order.number, token: r.data.order.token });
            setAccepting(false);
            router.refresh();
          }}
        >
          <p className="font-medium sm:col-span-2">Where should we deliver?</p>
          <div>
            <label htmlFor={`ac-n-${q.number}`} className="label">
              Contact name
            </label>
            <input id={`ac-n-${q.number}`} className="input" value={f.customerName} onChange={set("customerName")} required />
          </div>
          <div>
            <label htmlFor={`ac-p-${q.number}`} className="label">
              Mobile number
            </label>
            <input id={`ac-p-${q.number}`} className="input" value={f.phone} onChange={set("phone")} required inputMode="tel" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`ac-e-${q.number}`} className="label">
              Email for the order
            </label>
            <input id={`ac-e-${q.number}`} type="email" className="input" value={f.email} onChange={set("email")} required />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`ac-a-${q.number}`} className="label">
              Address
            </label>
            <input id={`ac-a-${q.number}`} className="input" value={f.addressLine1} onChange={set("addressLine1")} required />
          </div>
          <div>
            <label htmlFor={`ac-c-${q.number}`} className="label">
              City
            </label>
            <input id={`ac-c-${q.number}`} className="input" value={f.city} onChange={set("city")} required />
          </div>
          <div>
            <label htmlFor={`ac-pin-${q.number}`} className="label">
              Pincode
            </label>
            <input id={`ac-pin-${q.number}`} className="input" value={f.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`ac-s-${q.number}`} className="label">
              State
            </label>
            <select id={`ac-s-${q.number}`} className="input" value={f.state} onChange={set("state")} required>
              <option value="">Select state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 sm:col-span-2">
            <button className="btn btn-sm" disabled={busy}>
              {busy ? "Placing order…" : `Place order for ${q.total != null ? formatPrice(q.total) : ""}`}
            </button>
            <button type="button" className="link-underline text-[13px]" onClick={() => setAccepting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {err && (
        <p role="alert" className="field-error">
          {err}
        </p>
      )}
    </article>
  );
}
