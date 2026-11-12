"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "./api";

/** Email one-time-code sign-in (M5). First sign-in for an address also asks for consent, but only after the code proved the address. */
export function SignIn() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [needTerms, setNeedTerms] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    const r = await api("POST", "/api/account/otp/request", { email });
    setBusy(false);
    if (r.status === 503) return setErr("Sign-in by email is not available yet. You can still order as a guest.");
    if (!r.ok) return setErr(errorText(r));
    setStep("code");
    setMsg("If that address is valid, a 6-digit code is on its way. It stays valid for 10 minutes.");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await api("POST", "/api/account/otp/verify", { email, code, ...(terms ? { acceptTerms: true } : {}), ...(marketing ? { marketing: true } : {}) });
    setBusy(false);
    if (r.ok) return router.refresh();
    if (r.status === 409 && r.data.code === "terms_required") {
      setNeedTerms(true);
      return setErr("Welcome! To create your account, please accept the terms and privacy notice below, then continue.");
    }
    setErr(errorText(r));
  }

  return (
    <div className="container-site flex min-h-[60vh] items-center justify-center py-16">
      <form className="w-full max-w-[400px] rounded-[14px] bg-sage p-8" onSubmit={step === "email" ? requestCode : verify} aria-label="Sign in">
        <h1 className="text-[40px] leading-none">Your account</h1>
        <p className="mt-3 text-[13px] text-forest/75">Sign in with a one-time code sent to your email. No password to remember. You can always check out as a guest.</p>
        <label htmlFor="acct-email" className="label mt-6">
          Email
        </label>
        <input id="acct-email" type="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={step === "code"} />
        {step === "code" && (
          <>
            <label htmlFor="acct-code" className="label mt-4">
              6-digit code
            </label>
            <input id="acct-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className="input tracking-[0.3em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
            {needTerms && (
              <div className="mt-4 space-y-2 text-[12.5px]">
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5" /> I agree to the terms and privacy notice, and to my details being used for my orders.
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-0.5" /> (Optional) Send me news and offers. I can withdraw this any time.
                </label>
              </div>
            )}
          </>
        )}
        {msg && (
          <p role="status" className="mt-3 text-[12px] text-leaf">
            {msg}
          </p>
        )}
        {err && <p className="field-error">{err}</p>}
        <button className="btn mt-6 w-full" disabled={busy || (needTerms && !terms)}>
          {busy ? "Please wait…" : step === "email" ? "Email me a code" : needTerms ? "Create account and sign in" : "Sign in"}
        </button>
        {step === "code" && (
          <button type="button" className="link-underline mt-3 text-[12.5px]" onClick={() => (setStep("email"), setCode(""), setErr(null), setMsg(null), setNeedTerms(false))}>
            Use a different email
          </button>
        )}
      </form>
    </div>
  );
}
