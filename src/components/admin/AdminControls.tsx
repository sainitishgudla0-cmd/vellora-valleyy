"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ORDER_STATUSES } from "./statuses";

async function patch(url: string, body: unknown) {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update failed");
  return res.json();
}

/**
 * `emailRequired` is false only while the shared-password transition login is still enabled on the server
 * (ADMIN_LEGACY_LOGIN, ADR 0012): an empty email then signs in with the shared password.
 */
export function AdminLogin({ emailRequired = true }: { emailRequired?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="container-site flex min-h-[60vh] items-center justify-center py-16">
      <form
        className="w-full max-w-[380px] rounded-[14px] bg-sage p-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(email.trim() ? { email: email.trim(), password: pw } : { password: pw }) });
          setBusy(false);
          if (res.ok) router.refresh();
          else setErr((await res.json()).error ?? "Login failed");
        }}
      >
        <h1 className="text-[40px] leading-none">Admin</h1>
        <label htmlFor="admin-email" className="label mt-6">
          {emailRequired ? "Email" : "Email (leave empty for the shared password)"}
        </label>
        <input id="admin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="input" required={emailRequired} />
        <label htmlFor="admin-pw" className="label mt-4">
          Password
        </label>
        <input id="admin-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} className="input" required />
        {err && <p className="field-error">{err}</p>}
        <button className="btn mt-6 w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export function AdminLogout() {
  const router = useRouter();
  return (
    <button
      className="link-underline text-[13px]"
      onClick={async () => {
        await fetch("/api/admin/logout", { method: "POST" });
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

/** Deletes records created by the automated tests (named "SMOKE TEST…" / emails starting "smoke."). */
export function RemoveTestData({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      className="rounded-full border border-forest/30 px-3 py-1.5 text-[12px] hover:bg-sage disabled:opacity-50"
      onClick={async () => {
        if (!window.confirm(`Delete ${count} test record(s) created by the automated tests? Real orders are not affected.`)) return;
        setBusy(true);
        await fetch("/api/admin/test-data", { method: "DELETE" });
        setBusy(false);
        router.refresh();
      }}
    >
      {busy ? "Removing…" : `Remove test data (${count})`}
    </button>
  );
}

export function OrderStatusSelect({ id, status }: { id: string; status: string }) {
  const [v, setV] = useState(status);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  return (
    <div className="flex items-center gap-2">
      <select
        value={v}
        aria-label="Order status"
        onChange={async (e) => {
          const next = e.target.value;
          setV(next);
          setState("saving");
          try {
            await patch(`/api/admin/orders/${id}`, { status: next });
            setState("saved");
          } catch {
            setState("error");
            setV(status);
          }
        }}
        className="rounded-[8px] border border-forest/25 bg-cream-light px-2 py-1.5 text-[12px]"
      >
        {ORDER_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-forest/60">{state === "saving" ? "…" : state === "saved" ? "Saved" : state === "error" ? "Error" : ""}</span>
    </div>
  );
}

export function EnquiryStatus({ id, status }: { id: string; status: string }) {
  const [v, setV] = useState(status);
  return (
    <select
      value={v}
      aria-label="Enquiry status"
      onChange={async (e) => {
        const next = e.target.value;
        setV(next);
        try {
          await patch(`/api/admin/enquiries/${id}`, { status: next });
        } catch {
          setV(status);
        }
      }}
      className="rounded-[8px] border border-forest/25 bg-cream-light px-2 py-1 text-[12px]"
    >
      <option value="new">New</option>
      <option value="in_progress">In progress</option>
      <option value="closed">Closed</option>
    </select>
  );
}

export function VariantEditor({ id, price, inStock }: { id: string; price: number; inStock: boolean }) {
  const [p, setP] = useState(String(price));
  const [stock, setStock] = useState(inStock);
  const [msg, setMsg] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = Number(p);
        if (!Number.isFinite(n) || n <= 0) return setMsg("Invalid price");
        setMsg("…");
        try {
          await patch(`/api/admin/variants/${id}`, { price: n, inStock: stock });
          setMsg("Saved");
        } catch (err) {
          setMsg((err as Error).message);
        }
      }}
    >
      <span className="text-forest/60">₹</span>
      <input value={p} onChange={(e) => setP(e.target.value)} inputMode="decimal" aria-label="Selling price in rupees" className="w-20 rounded-[6px] border border-forest/25 bg-cream-light px-2 py-1" />
      <label className="flex items-center gap-1.5 text-[12px]">
        <input type="checkbox" checked={stock} onChange={(e) => setStock(e.target.checked)} /> In stock
      </label>
      <button className="rounded-full bg-forest px-3 py-1 text-[11px] text-cream">Save</button>
      <span className="text-[11px] text-forest/60">{msg}</span>
    </form>
  );
}
