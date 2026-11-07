"use client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { site } from "@/config/site";
import { customerSchema, fieldErrors, INDIAN_STATES } from "@/lib/validation";
import { cartCount, cartSubtotal, syncCartWithServer, useCart, useCartHydrated } from "@/store/cart";
import { cn, formatPrice } from "@/lib/format";
import { Frame } from "@/components/ui/Ornaments";
import { Roll } from "@/components/ui/Button";
import { IconArrowRight } from "@/components/ui/Icons";

type Fields = {
  customerName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  notes: string;
};
const EMPTY: Fields = { customerName: "", email: "", phone: "", addressLine1: "", addressLine2: "", city: "", state: "", pincode: "", notes: "" };

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: () => void) => void };
  }
}

function loadRazorpay() {
  return new Promise<boolean>((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export function CheckoutForm({ online, cod }: { online: boolean; cod: boolean }) {
  const router = useRouter();
  const { lines, clear } = useCart();
  const hydrated = useCartHydrated();
  const [f, setF] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<"cod" | "razorpay">(cod ? "cod" : "razorpay");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated) syncCartWithServer();
  }, [hydrated]);

  // remember contact details on this device (convenience only)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vv-checkout");
      if (saved) setF((x) => ({ ...x, ...JSON.parse(saved), notes: "" }));
    } catch {
      /* ignore */
    }
  }, []);

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: "" }));
  };

  const validateField = (k: keyof Fields) => {
    const r = customerSchema.safeParse(f);
    const errs = r.success ? {} : fieldErrors(r.error);
    setErrors((x) => ({ ...x, [k]: errs[k] ?? "" }));
  };

  if (!hydrated) return <div className="container-site h-[50vh]" aria-busy="true" />;
  if (!lines.length)
    return (
      <div className="container-site pb-24">
        <div className="rounded-[18px] border-[1.5px] border-dashed border-forest/30 px-6 py-20 text-center">
          <p className="display text-[44px] leading-none">Your cart is empty</p>
          <Link href="/shop" className="btn mt-8">
            Explore our products
          </Link>
        </div>
      </div>
    );

  const subtotal = cartSubtotal(lines);
  const total = subtotal + site.delivery.fee;
  const blocked = lines.some((l) => l.unavailable);
  const canPay = (method === "cod" && cod) || (method === "razorpay" && online);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const r = customerSchema.safeParse(f);
    if (!r.success) {
      const errs = fieldErrors(r.error);
      setErrors(errs);
      document.getElementById(`f-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    if (!canPay) {
      setFormError("Please choose an available payment option.");
      return;
    }
    setSubmitting(true);
    try {
      try {
        const { notes, ...rest } = f;
        void notes;
        localStorage.setItem("vv-checkout", JSON.stringify(rest));
      } catch {
        /* ignore */
      }
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, paymentMethod: method, items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.fields) setErrors(data.fields);
        throw new Error(data.error ?? "Could not place your order.");
      }
      const { number, token } = data.order;
      const confirmUrl = `/order/${number}?t=${encodeURIComponent(token)}`;

      if (method === "razorpay" && data.payment) {
        const ok = await loadRazorpay();
        if (!ok || !window.Razorpay) throw new Error("Could not load the payment window. Please check your connection and try again.");
        const rzp = new window.Razorpay({
          key: data.payment.keyId,
          order_id: data.payment.orderId,
          amount: data.payment.amount,
          currency: data.payment.currency,
          name: site.name,
          description: `Order ${number}`,
          prefill: { name: f.customerName, email: f.email, contact: f.phone },
          theme: { color: "#13402d" },
          handler: async (resp: Record<string, string>) => {
            const v = await fetch("/api/payments/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderNumber: number, token, ...resp }),
            });
            clear();
            router.push(v.ok ? confirmUrl : `${confirmUrl}&payment=failed`);
          },
          modal: {
            ondismiss: () => {
              setSubmitting(false);
              setFormError(`Payment was not completed. Your order ${number} is saved as awaiting payment — you can try again or choose pay on delivery.`);
            },
          },
        });
        rzp.open();
        return;
      }

      clear();
      router.push(confirmUrl);
    } catch (err) {
      setFormError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="container-site grid grid-cols-1 gap-10 pb-24 lg:grid-cols-[1fr_420px]">
      <div className="space-y-12">
        <Section n={1} title="Contact details">
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
            <Field id="customerName" label="Full name" value={f.customerName} onChange={set("customerName")} onBlur={() => validateField("customerName")} error={errors.customerName} autoComplete="name" className="sm:col-span-2" />
            <Field id="phone" label="Mobile number" value={f.phone} onChange={set("phone")} onBlur={() => validateField("phone")} error={errors.phone} type="tel" inputMode="tel" autoComplete="tel" placeholder="10-digit mobile" />
            <Field id="email" label="Email" value={f.email} onChange={set("email")} onBlur={() => validateField("email")} error={errors.email} type="email" autoComplete="email" />
          </div>
        </Section>

        <Section n={2} title="Delivery address">
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
            <Field id="addressLine1" label="House / flat, street" value={f.addressLine1} onChange={set("addressLine1")} onBlur={() => validateField("addressLine1")} error={errors.addressLine1} autoComplete="address-line1" className="sm:col-span-2" />
            <Field id="addressLine2" label="Area, landmark (optional)" value={f.addressLine2} onChange={set("addressLine2")} autoComplete="address-line2" className="sm:col-span-2" />
            <Field id="city" label="City / town" value={f.city} onChange={set("city")} onBlur={() => validateField("city")} error={errors.city} autoComplete="address-level2" />
            <Field id="pincode" label="Pincode" value={f.pincode} onChange={set("pincode")} onBlur={() => validateField("pincode")} error={errors.pincode} inputMode="numeric" autoComplete="postal-code" maxLength={6} />
            <div className="sm:col-span-2">
              <label htmlFor="f-state" className="label">
                State
              </label>
              <select
                id="f-state"
                value={f.state}
                onChange={set("state")}
                onBlur={() => validateField("state")}
                aria-invalid={!!errors.state}
                aria-describedby={errors.state ? "e-state" : undefined}
                autoComplete="address-level1"
                className="input cursor-pointer"
              >
                <option value="">Select your state</option>
                {INDIAN_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {errors.state && (
                <p id="e-state" className="field-error">
                  {errors.state}
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="f-notes" className="label">
                Order notes (optional)
              </label>
              <textarea id="f-notes" value={f.notes} onChange={set("notes")} rows={2} maxLength={500} className="input resize-none" placeholder="Delivery instructions, preferred call time…" />
            </div>
          </div>
        </Section>

        <Section n={3} title="Payment">
          <div className="grid gap-3">
            <PayOption
              checked={method === "cod"}
              disabled={!cod}
              onSelect={() => setMethod("cod")}
              title="Pay on delivery"
              text="Place an order request now. Our team will call you to confirm availability and any delivery charges, then you pay when it arrives."
            />
            <PayOption
              checked={method === "razorpay"}
              disabled={!online}
              onSelect={() => setMethod("razorpay")}
              title="Pay online (UPI, cards, netbanking)"
              text={online ? "Secure payment via Razorpay. Your order is confirmed once payment is verified." : "Online payment is not available yet. It will appear here once the store's payment account is connected."}
              badge={online ? undefined : "Coming soon"}
            />
          </div>
          {errors.paymentMethod && <p className="field-error">{errors.paymentMethod}</p>}
        </Section>
      </div>

      <aside className="lg:sticky lg:top-[100px] lg:self-start">
        <Frame tone="sage" n={20} innerClassName="p-6">
          <h2 className="text-[34px] leading-none">Your order</h2>
          <ul className="mt-5 max-h-[320px] space-y-3 overflow-y-auto pr-1" data-lenis-prevent>
            {lines.map((l) => (
              <li key={l.variantId} className="flex items-center gap-3">
                <span className="relative h-14 w-12 shrink-0 overflow-hidden rounded-[8px] bg-dough">
                  <Image src={l.image} alt="" fill sizes="48px" className="object-cover" />
                  <span className="absolute -right-0 -top-0 flex h-5 min-w-5 items-center justify-center rounded-bl-[6px] bg-forest px-1 text-[10px] text-cream">{l.quantity}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{l.name}</span>
                  <span className="text-[11.5px] text-forest/60">{l.label}</span>
                  {l.unavailable && <span className="block text-[11.5px] text-red-700">Unavailable — remove from cart</span>}
                </span>
                <span className="text-[13px]">{formatPrice(l.price * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-5 space-y-2 border-t-[1.5px] border-dashed border-forest/30 pt-4 text-[13.5px]">
            <div className="flex justify-between">
              <dt>Subtotal ({cartCount(lines)} items)</dt>
              <dd>{formatPrice(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Delivery</dt>
              <dd>{site.delivery.fee > 0 ? formatPrice(site.delivery.fee) : "To be confirmed"}</dd>
            </div>
            <div className="flex items-baseline justify-between pt-2">
              <dt className="eyebrow">Total</dt>
              <dd className="display text-[38px] leading-none">{formatPrice(total)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-forest/60">{site.delivery.note}</p>

          {formError && (
            <p role="alert" className="mt-4 rounded-[8px] bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
              {formError}
            </p>
          )}
          <button type="submit" disabled={submitting || blocked || !canPay} className="btn btn-lg mt-5 w-full">
            <Roll>{submitting ? "Placing order…" : method === "razorpay" ? `Pay ${formatPrice(total)}` : "Place order request"}</Roll>
            {!submitting && <IconArrowRight width={18} />}
          </button>
          {blocked && <p className="mt-2 text-[12px] text-red-700">Please remove unavailable items from your cart first.</p>}
          <p className="mt-3 text-center text-[11px] text-forest/55">
            By placing an order you agree to be contacted by {site.company} about it.
          </p>
        </Frame>
      </aside>
    </form>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-forest font-display text-[20px] font-bold text-gold-light">{n}</span>
        <span className="display text-[34px] leading-none">{title}</span>
      </legend>
      {children}
    </fieldset>
  );
}

function Field({
  id,
  label,
  error,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; error?: string }) {
  return (
    <div className={className}>
      <label htmlFor={`f-${id}`} className="label">
        {label}
      </label>
      <input id={`f-${id}`} name={id} aria-invalid={!!error} aria-describedby={error ? `e-${id}` : undefined} className="input" {...rest} />
      {error && (
        <p id={`e-${id}`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

function PayOption({ checked, disabled, onSelect, title, text, badge }: { checked: boolean; disabled?: boolean; onSelect: () => void; title: string; text: string; badge?: string }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-4 rounded-[12px] border-[1.5px] p-4 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold",
        checked && !disabled ? "border-forest bg-sage/60" : "border-forest/20 hover:border-forest/50",
        disabled && "cursor-not-allowed opacity-60 hover:border-forest/20",
      )}
    >
      <input type="radio" name="payment" className="sr-only" checked={checked && !disabled} disabled={disabled} onChange={onSelect} />
      <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-forest", checked && !disabled && "bg-forest")}>
        {checked && !disabled && <span className="h-2 w-2 rounded-full bg-cream" />}
      </span>
      <span>
        <span className="flex items-center gap-2 text-[14px] font-medium">
          {title}
          {badge && <span className="rounded-full bg-butter px-2 py-0.5 text-[10px] uppercase tracking-wider">{badge}</span>}
        </span>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-forest/70">{text}</span>
      </span>
    </label>
  );
}
