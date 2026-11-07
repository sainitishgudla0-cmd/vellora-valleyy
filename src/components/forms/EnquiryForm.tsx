"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { BUSINESS_INTERESTS, enquirySchema, fieldErrors } from "@/lib/validation";
import { cn } from "@/lib/format";
import { Roll } from "@/components/ui/Button";
import { IconArrowRight, IconCheck } from "@/components/ui/Icons";

type Interest = keyof typeof BUSINESS_INTERESTS;

export function EnquiryForm({ type, defaultInterest, defaultMessage = "" }: { type: "contact" | "business"; defaultInterest?: Interest; defaultMessage?: string }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "", city: "", message: defaultMessage, website: "" });
  const [interest, setInterest] = useState<Interest | undefined>(defaultInterest);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [formError, setFormError] = useState<string | null>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: "" }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = { ...f, type, interest: type === "business" ? interest : undefined };
    const r = enquirySchema.safeParse(payload);
    if (!r.success) {
      const errs = fieldErrors(r.error);
      setErrors(errs);
      document.getElementById(`q-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setState("sending");
    try {
      const res = await fetch("/api/enquiries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        if (data.fields) setErrors(data.fields);
        throw new Error(data.error ?? "Could not send your message.");
      }
      setState("sent");
    } catch (err) {
      setFormError((err as Error).message);
      setState("idle");
    }
  }

  return (
    <AnimatePresence mode="wait">
      {state === "sent" ? (
        <motion.div key="sent" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="py-10 text-center" role="status">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-forest text-gold-light">
            <IconCheck width={30} />
          </span>
          <p className="display mt-5 text-[40px] leading-none">Thank you, {f.name.split(" ")[0]}!</p>
          <p className="mx-auto mt-3 max-w-[40ch] text-[13.5px] text-forest/75">
            Your {type === "business" ? "business enquiry" : "message"} has been received. Our team will get back to you at {f.email}
            {f.phone ? ` or ${f.phone}` : ""}.
          </p>
        </motion.div>
      ) : (
        <motion.form key="form" onSubmit={submit} noValidate exit={{ opacity: 0, y: -10 }} className="space-y-6">
          {type === "business" && (
            <fieldset>
              <legend className="label">I&apos;m interested in</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(Object.keys(BUSINESS_INTERESTS) as Interest[]).map((k) => (
                  <label
                    key={k}
                    className={cn(
                      "cursor-pointer rounded-full border-[1.5px] px-3.5 py-2 text-[12.5px] transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold",
                      interest === k ? "border-forest bg-forest text-cream" : "border-forest/25 hover:border-forest",
                    )}
                  >
                    <input
                      type="radio"
                      name="interest"
                      className="sr-only"
                      id={k === "distributor" ? "q-interest" : undefined}
                      checked={interest === k}
                      onChange={() => {
                        setInterest(k);
                        setErrors((x) => ({ ...x, interest: "" }));
                      }}
                    />
                    {BUSINESS_INTERESTS[k]}
                  </label>
                ))}
              </div>
              {errors.interest && <p className="field-error">{errors.interest}</p>}
            </fieldset>
          )}
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
            <F id="name" label="Your name" value={f.name} onChange={set("name")} error={errors.name} autoComplete="name" />
            <F id="email" label="Email" type="email" value={f.email} onChange={set("email")} error={errors.email} autoComplete="email" />
            <F id="phone" label={type === "business" ? "Phone" : "Phone (optional)"} type="tel" value={f.phone} onChange={set("phone")} error={errors.phone} autoComplete="tel" />
            {type === "business" ? (
              <F id="company" label="Company / business name" value={f.company} onChange={set("company")} error={errors.company} autoComplete="organization" />
            ) : (
              <F id="city" label="City (optional)" value={f.city} onChange={set("city")} error={errors.city} autoComplete="address-level2" />
            )}
            {type === "business" && <F id="city" label="City / region" value={f.city} onChange={set("city")} error={errors.city} className="sm:col-span-2" />}
          </div>
          <div>
            <label htmlFor="q-message" className="label">
              {type === "business" ? "Tell us about your requirement" : "Message"}
            </label>
            <textarea
              id="q-message"
              rows={5}
              value={f.message}
              onChange={set("message")}
              aria-invalid={!!errors.message}
              aria-describedby={errors.message ? "qe-message" : undefined}
              maxLength={2000}
              className="input resize-y"
              placeholder={type === "business" ? "Products, approximate volumes, location, timelines…" : "How can we help?"}
            />
            {errors.message && (
              <p id="qe-message" className="field-error">
                {errors.message}
              </p>
            )}
          </div>
          {/* honeypot */}
          <input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} className="hidden" aria-hidden name="website" />
          {formError && (
            <p role="alert" className="rounded-[8px] bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
              {formError}
            </p>
          )}
          <button type="submit" disabled={state === "sending"} className="btn btn-lg">
            <Roll>{state === "sending" ? "Sending…" : type === "business" ? "Send business enquiry" : "Send message"}</Roll>
            <IconArrowRight width={18} />
          </button>
        </motion.form>
      )}
    </AnimatePresence>
  );
}

function F({ id, label, error, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; error?: string }) {
  return (
    <div className={className}>
      <label htmlFor={`q-${id}`} className="label">
        {label}
      </label>
      <input id={`q-${id}`} aria-invalid={!!error} aria-describedby={error ? `qe-${id}` : undefined} className="input" {...rest} />
      {error && (
        <p id={`qe-${id}`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
