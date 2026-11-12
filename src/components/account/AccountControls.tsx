"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { INDIAN_STATES } from "@/lib/validation";
import { api, errorText } from "./api";

const small = "rounded-full border border-forest/30 px-3 py-1 text-[11px] hover:bg-sage disabled:opacity-50";

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="link-underline text-[13px]"
      onClick={async () => {
        await api("POST", "/api/account/logout", {});
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

export interface AddressView {
  id: string;
  label: string | null;
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

const EMPTY = { label: "", name: "", phone: "", line1: "", line2: "", city: "", state: "", pincode: "", isDefault: false };

export function ProfileForm({ name, phone }: { name: string | null; phone: string | null }) {
  const router = useRouter();
  const [f, setF] = useState({ name: name ?? "", phone: phone ?? "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="max-w-[420px] rounded-[12px] bg-sage p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await api("PATCH", "/api/account/me", { name: f.name.trim() || null, phone: f.phone.trim() || null });
        setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: errorText(r) });
        if (r.ok) router.refresh();
      }}
    >
      <h3 className="text-[15px] font-medium">Your details</h3>
      <label htmlFor="pf-name" className="label mt-4">
        Name
      </label>
      <input id="pf-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} autoComplete="name" />
      <label htmlFor="pf-phone" className="label mt-3">
        Mobile number
      </label>
      <input id="pf-phone" className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" autoComplete="tel" />
      {msg && (
        <p role="status" className={msg.ok ? "mt-2 text-[12px] text-leaf" : "field-error"}>
          {msg.text}
        </p>
      )}
      <button className="btn mt-4">Save</button>
    </form>
  );
}

/** Saved delivery addresses: list, add, edit, set default, delete (max 10, one default; the API enforces both). */
export function Addresses({ addresses }: { addresses: AddressView[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [f, setF] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (a?: AddressView) => {
    setErr(null);
    setEditing(a ? a.id : "new");
    setF(a ? { label: a.label ?? "", name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 ?? "", city: a.city, state: a.state, pincode: a.pincode, isDefault: a.isDefault } : EMPTY);
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body = { label: f.label.trim() || null, name: f.name, phone: f.phone, line1: f.line1, line2: f.line2.trim() || null, city: f.city, state: f.state, pincode: f.pincode, isDefault: f.isDefault };
    const r = editing === "new" ? await api("POST", "/api/account/addresses", body) : await api("PATCH", `/api/account/addresses/${editing}`, body);
    setBusy(false);
    if (!r.ok) return setErr(errorText(r));
    setEditing(null);
    router.refresh();
  }
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-4">
      {addresses.length === 0 && editing === null && <p className="py-4 text-[13.5px] text-forest/60">No saved addresses yet.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {addresses.map((a) => (
          <li key={a.id} className="rounded-[12px] border border-forest/15 bg-cream-light p-4 text-[13px]" data-testid="address">
            <p className="font-medium">
              {a.label || a.name} {a.isDefault && <span className="ml-1 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">Default</span>}
            </p>
            <p className="mt-1 text-forest/75">
              {a.name} · {a.phone}
              <br />
              {a.line1}
              {a.line2 ? `, ${a.line2}` : ""}
              <br />
              {a.city}, {a.state} {a.pincode}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={small} onClick={() => open(a)}>
                Edit
              </button>
              {!a.isDefault && (
                <button className={small} onClick={async () => ((await api("PATCH", `/api/account/addresses/${a.id}`, { isDefault: true })), router.refresh())}>
                  Make default
                </button>
              )}
              <button
                className={small}
                onClick={async () => {
                  if (!window.confirm("Delete this address?")) return;
                  await api("DELETE", `/api/account/addresses/${a.id}`);
                  router.refresh();
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing === null ? (
        <button className="btn btn-sm" onClick={() => open()}>
          Add an address
        </button>
      ) : (
        <form onSubmit={save} className="grid max-w-[560px] gap-3 rounded-[12px] bg-sage p-5 sm:grid-cols-2" aria-label="Address">
          <h3 className="text-[15px] font-medium sm:col-span-2">{editing === "new" ? "Add an address" : "Edit address"}</h3>
          <div>
            <label htmlFor="ad-label" className="label">
              Label (optional)
            </label>
            <input id="ad-label" className="input" value={f.label} onChange={set("label")} placeholder="Home, Office…" maxLength={40} />
          </div>
          <div>
            <label htmlFor="ad-name" className="label">
              Recipient name
            </label>
            <input id="ad-name" className="input" value={f.name} onChange={set("name")} required autoComplete="name" />
          </div>
          <div>
            <label htmlFor="ad-phone" className="label">
              Mobile number
            </label>
            <input id="ad-phone" className="input" value={f.phone} onChange={set("phone")} required inputMode="tel" autoComplete="tel" />
          </div>
          <div>
            <label htmlFor="ad-pin" className="label">
              Pincode
            </label>
            <input id="ad-pin" className="input" value={f.pincode} onChange={set("pincode")} required inputMode="numeric" maxLength={6} autoComplete="postal-code" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ad-line1" className="label">
              House / flat, street
            </label>
            <input id="ad-line1" className="input" value={f.line1} onChange={set("line1")} required autoComplete="address-line1" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ad-line2" className="label">
              Area, landmark (optional)
            </label>
            <input id="ad-line2" className="input" value={f.line2} onChange={set("line2")} autoComplete="address-line2" />
          </div>
          <div>
            <label htmlFor="ad-city" className="label">
              City / town
            </label>
            <input id="ad-city" className="input" value={f.city} onChange={set("city")} required autoComplete="address-level2" />
          </div>
          <div>
            <label htmlFor="ad-state" className="label">
              State
            </label>
            <select id="ad-state" className="input" value={f.state} onChange={set("state")} required>
              <option value="">Select state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-[12.5px] sm:col-span-2">
            <input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Use as my default address
          </label>
          {err && <p className="field-error sm:col-span-2">{err}</p>}
          <div className="flex gap-3 sm:col-span-2">
            <button className="btn btn-sm" disabled={busy}>
              {busy ? "Saving…" : "Save address"}
            </button>
            <button type="button" className="link-underline text-[13px]" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Link guest orders placed with the signed-in (verified) email to this account. */
export function ClaimOrders() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="rounded-[12px] bg-sage p-4 text-[13px]">
      <p className="font-medium">Ordered before as a guest?</p>
      <p className="mt-1 text-forest/75">We can add orders you placed with this email address to your account.</p>
      <button
        className="btn btn-sm mt-3"
        onClick={async () => {
          const r = await api("POST", "/api/account/claim", { mode: "email" });
          setMsg(r.ok ? (r.data.claimed ? `Added ${r.data.claimed} order(s) to your account.` : "No earlier guest orders found for this email.") : errorText(r));
          if (r.ok && r.data.claimed) router.refresh();
        }}
      >
        Find my earlier orders
      </button>
      {msg && (
        <p role="status" className="mt-2 text-[12px] text-leaf">
          {msg}
        </p>
      )}
    </div>
  );
}

/** Consent, download of your data, and account deletion (DPDP Act 2023). */
export function Privacy({ marketing }: { marketing: boolean }) {
  const router = useRouter();
  const [mk, setMk] = useState(marketing);
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="max-w-[620px] space-y-8">
      <section className="space-y-2 text-[13.5px]">
        <h3 className="text-[15px] font-medium">Marketing messages</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={mk}
            onChange={async (e) => {
              const next = e.target.checked;
              setMk(next);
              const r = await api("POST", "/api/account/consent", { marketing: next });
              if (!r.ok) setMk(!next);
            }}
          />{" "}
          Send me news and offers by email
        </label>
        <p className="text-[12px] text-forest/60">Order updates are always sent. You can change this any time.</p>
      </section>
      <section className="space-y-2 text-[13.5px]">
        <h3 className="text-[15px] font-medium">Your data</h3>
        <p className="text-forest/75">Download everything we hold about you (details, addresses, consent history, orders, enquiries) as a file.</p>
        <a className="btn btn-sm" href="/api/account/export" download>
          Download my data
        </a>
      </section>
      <section className="space-y-2 text-[13.5px]">
        <h3 className="text-[15px] font-medium">Delete my account</h3>
        <p className="text-forest/75">
          This removes your account, addresses and sign-ins. Orders we must keep for our records stay, with your name, contact and address removed. You can only delete once your orders are delivered or cancelled, and you need to have signed in within the last 10 minutes.
        </p>
        <label htmlFor="del-confirm" className="label">
          Type DELETE to confirm
        </label>
        <input id="del-confirm" className="input max-w-[220px]" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        <div>
          <button
            className="btn btn-sm mt-2"
            disabled={confirm !== "DELETE"}
            onClick={async () => {
              const r = await api("DELETE", "/api/account", { confirm: "DELETE" });
              if (r.ok) return router.refresh();
              setMsg({ ok: false, text: r.data.code === "reauth_required" ? "For your safety, please sign out and sign in again, then delete straight away." : errorText(r) });
            }}
          >
            Delete my account
          </button>
        </div>
        {msg && (
          <p role="alert" className={msg.ok ? "text-leaf" : "field-error"}>
            {msg.text}
          </p>
        )}
      </section>
    </div>
  );
}
