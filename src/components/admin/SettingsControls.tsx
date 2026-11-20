"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminApi, errorText } from "./api";

/**
 * Business configuration that staff enter themselves (M11 P4): shipping rules (fulfilment:write) and GST rates
 * (tax:write, owner, with the accountant's sign-off). No values are suggested or pre-filled: they are business data.
 */
function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? (
    <p role="status" className={msg.ok ? "mt-2 text-[12.5px] text-leaf" : "field-error"}>
      {msg.text}
    </p>
  ) : null;
}

const rupeesToPaise = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));

export function ShippingRuleForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", pincodePrefix: "", fee: "", freeAbove: "", serviceable: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="grid gap-2 text-[12.5px] sm:grid-cols-5 sm:items-end"
      data-testid="shipping-rule-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const fee = rupeesToPaise(f.fee) ?? 0;
        const freeAboveSubtotal = rupeesToPaise(f.freeAbove);
        if (!Number.isFinite(fee) || (freeAboveSubtotal !== null && !Number.isFinite(freeAboveSubtotal))) return setMsg({ ok: false, text: "Enter amounts in rupees" });
        setBusy(true);
        const r = await adminApi("POST", "/api/admin/shipping-rules", { name: f.name, pincodePrefix: f.pincodePrefix, serviceable: f.serviceable, fee, ...(freeAboveSubtotal !== null ? { freeAboveSubtotal } : {}) });
        setBusy(false);
        setMsg(r.ok ? { ok: true, text: "Rule added." } : { ok: false, text: errorText(r) });
        if (r.ok) {
          setF({ name: "", pincodePrefix: "", fee: "", freeAbove: "", serviceable: true });
          router.refresh();
        }
      }}
    >
      <label>
        Name
        <input className="input mt-1" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} />
      </label>
      <label>
        Pincode prefix (empty = all)
        <input className="input mt-1" inputMode="numeric" value={f.pincodePrefix} onChange={(e) => setF({ ...f, pincodePrefix: e.target.value })} pattern="\d{0,6}" />
      </label>
      <label>
        Fee ₹
        <input className="input mt-1" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} disabled={!f.serviceable} />
      </label>
      <label>
        Free above ₹ (optional)
        <input className="input mt-1" inputMode="decimal" value={f.freeAbove} onChange={(e) => setF({ ...f, freeAbove: e.target.value })} disabled={!f.serviceable} />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!f.serviceable} onChange={(e) => setF({ ...f, serviceable: !e.target.checked })} /> We do not deliver here
      </label>
      <button className="btn sm:justify-self-start" disabled={busy}>
        {busy ? "Adding…" : "Add rule"}
      </button>
      <div className="sm:col-span-5">
        <Note msg={msg} />
      </div>
    </form>
  );
}

export function ShippingRuleActions({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (method: "PATCH" | "DELETE", body?: unknown) => {
    setBusy(true);
    const r = await adminApi(method, `/api/admin/shipping-rules/${id}`, body);
    setBusy(false);
    setMsg(r.ok ? null : { ok: false, text: errorText(r) });
    if (r.ok) router.refresh();
  };
  return (
    <div className="flex gap-3 text-[12.5px]">
      <button className="link-underline" disabled={busy} onClick={() => act("PATCH", { active: !active })}>
        {active ? "Deactivate" : "Activate"}
      </button>
      <button className="link-underline" disabled={busy} onClick={() => window.confirm("Delete this rule?") && act("DELETE")}>
        Delete
      </button>
      <Note msg={msg} />
    </div>
  );
}

export function TaxRateForm() {
  const router = useRouter();
  const [f, setF] = useState({ code: "", percent: "", effectiveFrom: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="grid gap-2 text-[12.5px] sm:grid-cols-5 sm:items-end"
      data-testid="tax-rate-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const rateBp = Math.round(Number(f.percent) * 100);
        if (!Number.isFinite(rateBp)) return setMsg({ ok: false, text: "Enter the rate in percent" });
        if (!window.confirm(`Record GST ${f.percent}% for ${f.code.toUpperCase()} from ${f.effectiveFrom}? Rates are append-only; confirm it with the accountant first.`)) return;
        setBusy(true);
        const r = await adminApi("POST", "/api/admin/tax-rates", { code: f.code, rateBp, effectiveFrom: f.effectiveFrom, ...(f.note.trim() ? { note: f.note.trim() } : {}) });
        setBusy(false);
        setMsg(r.ok ? { ok: true, text: "Rate recorded." } : { ok: false, text: errorText(r) });
        if (r.ok) {
          setF({ code: "", percent: "", effectiveFrom: "", note: "" });
          router.refresh();
        }
      }}
    >
      <label>
        HSN code or DELIVERY
        <input className="input mt-1" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required />
      </label>
      <label>
        GST %
        <input className="input mt-1" inputMode="decimal" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} required />
      </label>
      <label>
        Effective from
        <input className="input mt-1" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} required />
      </label>
      <label>
        Note (e.g. approved by)
        <input className="input mt-1" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />
      </label>
      <button className="btn sm:justify-self-start" disabled={busy}>
        {busy ? "Saving…" : "Record rate"}
      </button>
      <div className="sm:col-span-5">
        <Note msg={msg} />
      </div>
    </form>
  );
}
