"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminApi, errorText } from "./api";

export const ADMIN_ROLE_OPTIONS = [
  { value: "owner", label: "Owner — everything, manages the team" },
  { value: "operations", label: "Operations — orders, enquiries, stock" },
  { value: "catalog", label: "Catalog — prices and stock" },
  { value: "viewer", label: "Viewer — read only" },
] as const;

const small = "rounded-full border border-forest/30 px-3 py-1 text-[11px] hover:bg-sage disabled:opacity-50";

/** Change your own password. Ends every other session of yours. */
export function ChangePasswordForm() {
  const router = useRouter();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="max-w-[420px] rounded-[12px] bg-sage p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (next !== again) return setMsg({ ok: false, text: "The new passwords do not match" });
        setBusy(true);
        setMsg(null);
        const r = await adminApi("POST", "/api/admin/account/password", { currentPassword: cur, newPassword: next });
        setBusy(false);
        if (!r.ok) return setMsg({ ok: false, text: errorText(r) });
        setCur("");
        setNext("");
        setAgain("");
        setMsg({ ok: true, text: r.data.sessionsRevoked ? `Password changed. ${r.data.sessionsRevoked} other session(s) signed out.` : "Password changed." });
        router.refresh();
      }}
    >
      <h3 className="text-[15px] font-medium">Change password</h3>
      <label htmlFor="pw-current" className="label mt-4">
        Current password
      </label>
      <input id="pw-current" type="password" autoComplete="current-password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} required />
      <label htmlFor="pw-new" className="label mt-3">
        New password (12+ characters)
      </label>
      <input id="pw-new" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} required />
      <label htmlFor="pw-again" className="label mt-3">
        Repeat new password
      </label>
      <input id="pw-again" type="password" autoComplete="new-password" className="input" value={again} onChange={(e) => setAgain(e.target.value)} minLength={12} required />
      {msg && (
        <p role="status" className={msg.ok ? "mt-3 text-[12px] text-leaf" : "field-error"}>
          {msg.text}
        </p>
      )}
      <button className="btn mt-5" disabled={busy}>
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}

export interface SessionView {
  id: string;
  who: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN");
const shortAgent = (ua: string | null) => (ua ? ua.replace(/\s*\(.*?\)\s*/g, " ").slice(0, 60) : "Unknown device");

/** Live sessions with a "Sign out" button each. The current one is marked and signing it out returns to the login screen. */
export function SessionsTable({ sessions, showWho }: { sessions: SessionView[]; showWho: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (sessions.length === 0) return <p className="py-4 text-[13px] text-forest/60">No active sessions.</p>;
  return (
    <div className="overflow-x-auto">
      {err && <p className="field-error">{err}</p>}
      <table className="w-full min-w-[640px] text-left text-[12.5px]">
        <thead className="text-[11px] uppercase tracking-wider text-forest/60">
          <tr>
            {showWho && <th className="py-2 pr-3">Account</th>}
            <th className="py-2 pr-3">Device</th>
            <th className="py-2 pr-3">Signed in</th>
            <th className="py-2 pr-3">Last active</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-forest/10">
          {sessions.map((s) => (
            <tr key={s.id}>
              {showWho && <td className="py-2.5 pr-3">{s.who}</td>}
              <td className="py-2.5 pr-3">
                {shortAgent(s.userAgent)} {s.current && <span className="ml-1 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">This device</span>}
              </td>
              <td className="py-2.5 pr-3">{when(s.createdAt)}</td>
              <td className="py-2.5 pr-3">{when(s.lastSeenAt)}</td>
              <td className="py-2.5">
                <button
                  className={small}
                  disabled={busy === s.id}
                  aria-label={`Sign out session from ${shortAgent(s.userAgent)}`}
                  onClick={async () => {
                    setBusy(s.id);
                    setErr(null);
                    const r = await adminApi("DELETE", `/api/admin/sessions/${s.id}`);
                    setBusy(null);
                    if (!r.ok) return setErr(errorText(r));
                    router.refresh();
                  }}
                >
                  {busy === s.id ? "…" : "Sign out"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  locked: boolean;
  lastLoginAt: string | null;
}

/** Owner-only: create accounts and change role / active / password / lock. The API protects the last owner and ends sessions on every access change. */
export function TeamManager({ users, currentUserId }: { users: UserView[]; currentUserId: string | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [form, setForm] = useState({ email: "", name: "", role: "operations", password: "" });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(id: string, body: Record<string, unknown>, ok: string) {
    setMsg((m) => ({ ...m, [id]: "…" }));
    const r = await adminApi("PATCH", `/api/admin/users/${id}`, body);
    if (!r.ok) return setMsg((m) => ({ ...m, [id]: errorText(r) }));
    setMsg((m) => ({ ...m, [id]: ok }));
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-[12.5px]">
          <thead className="text-[11px] uppercase tracking-wider text-forest/60">
            <tr>
              <th className="py-2 pr-3">Person</th>
              <th className="py-2 pr-3">Role</th>
              <th className="py-2 pr-3">Last sign-in</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-forest/10">
            {users.map((u) => (
              <tr key={u.id} className="align-top">
                <td className="py-3 pr-3">
                  <span className="font-medium">{u.name}</span>
                  {u.id === currentUserId && <span className="ml-2 text-forest/60">(you)</span>}
                  <br />
                  <span className="text-forest/60">{u.email}</span>
                </td>
                <td className="py-3 pr-3">
                  <select
                    aria-label={`Role for ${u.email}`}
                    value={u.role}
                    className="rounded-[8px] border border-forest/25 bg-cream-light px-2 py-1.5 text-[12px]"
                    onChange={(e) => {
                      if (u.id === currentUserId && !window.confirm("Change your own role? You may lose access to this screen.")) return;
                      void change(u.id, { role: e.target.value }, "Role updated; their sessions were signed out");
                    }}
                  >
                    {ADMIN_ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.value}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-3 pr-3">{u.lastLoginAt ? when(u.lastLoginAt) : "Never"}</td>
                <td className="py-3 pr-3">
                  {u.active ? "Active" : <span className="text-forest/60">Disabled</span>}
                  {u.locked && <span className="ml-2 rounded-full bg-gold px-2 py-0.5 text-[10px] uppercase tracking-wider">Locked</span>}
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={small}
                      onClick={() => {
                        if (u.active && !window.confirm(`Disable ${u.email}? They are signed out immediately.`)) return;
                        void change(u.id, { active: !u.active }, u.active ? "Disabled" : "Enabled");
                      }}
                    >
                      {u.active ? "Disable" : "Enable"}
                    </button>
                    {u.locked && (
                      <button className={small} onClick={() => void change(u.id, { unlock: true }, "Unlocked")}>
                        Unlock
                      </button>
                    )}
                    <button className={small} onClick={() => (setResetFor(resetFor === u.id ? null : u.id), setResetPw(""))}>
                      Reset password
                    </button>
                    <span role="status" className="text-[11px] text-forest/60">
                      {msg[u.id]}
                    </span>
                  </div>
                  {resetFor === u.id && (
                    <form
                      className="mt-2 flex flex-wrap items-center gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await change(u.id, { password: resetPw }, "Password reset; their sessions were signed out");
                        setResetFor(null);
                        setResetPw("");
                      }}
                    >
                      <input type="password" autoComplete="new-password" aria-label={`New password for ${u.email}`} placeholder="New password (12+ characters)" minLength={12} required value={resetPw} onChange={(e) => setResetPw(e.target.value)} className="w-56 rounded-[6px] border border-forest/25 bg-cream-light px-2 py-1" />
                      <button className="rounded-full bg-forest px-3 py-1 text-[11px] text-cream">Set password</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="max-w-[460px] rounded-[12px] bg-sage p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setCreateErr(null);
          const r = await adminApi("POST", "/api/admin/users", form);
          setBusy(false);
          if (!r.ok) return setCreateErr(errorText(r));
          setForm({ email: "", name: "", role: "operations", password: "" });
          router.refresh();
        }}
      >
        <h3 className="text-[15px] font-medium">Add a person</h3>
        <label htmlFor="new-name" className="label mt-4">
          Name
        </label>
        <input id="new-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
        <label htmlFor="new-email" className="label mt-3">
          Email
        </label>
        <input id="new-email" type="email" autoComplete="off" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required maxLength={200} />
        <label htmlFor="new-role" className="label mt-3">
          Role
        </label>
        <select id="new-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {ADMIN_ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label htmlFor="new-password" className="label mt-3">
          Initial password (12+ characters — share it privately)
        </label>
        <input id="new-password" type="password" autoComplete="new-password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} required />
        {createErr && <p className="field-error">{createErr}</p>}
        <button className="btn mt-5" disabled={busy}>
          {busy ? "Adding…" : "Add person"}
        </button>
      </form>
    </div>
  );
}
