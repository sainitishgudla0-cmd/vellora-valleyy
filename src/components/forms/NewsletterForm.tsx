"use client";
import { useState } from "react";
import { cn } from "@/lib/format";
import { IconArrowRight, IconCheck } from "@/components/ui/Icons";

export function NewsletterForm({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    try {
      const res = await fetch("/api/newsletter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.fields?.email ?? data.error ?? "Something went wrong");
      setState("done");
      setMsg("Thank you — you're on the list.");
      setEmail("");
    } catch (err) {
      setState("error");
      setMsg((err as Error).message);
    }
  }

  const dark = tone === "dark";
  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={`nl-${tone}`} className={cn("eyebrow mb-2 block", dark ? "text-cream/70" : "text-forest/70")}>
        Newsletter
      </label>
      <div className={cn("flex items-center gap-2 rounded-full border-[1.5px] p-1 pl-4", dark ? "border-cream/30 focus-within:border-gold" : "border-forest/30 focus-within:border-forest")}>
        <input
          id={`nl-${tone}`}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          aria-invalid={state === "error"}
          aria-describedby={`nl-${tone}-msg`}
          className={cn("min-w-0 flex-1 bg-transparent py-2 text-[14px] outline-none", dark ? "placeholder:text-cream/40" : "placeholder:text-forest/40")}
        />
        <button
          type="submit"
          disabled={state === "loading"}
          aria-label="Subscribe"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold text-forest-deep transition-transform duration-500 ease-out-expo hover:scale-110 disabled:opacity-60"
        >
          {state === "done" ? <IconCheck width={18} /> : <IconArrowRight width={18} />}
        </button>
      </div>
      <p id={`nl-${tone}-msg`} className={cn("mt-2 min-h-[1.2em] text-[12px]", state === "error" ? "text-red-300" : dark ? "text-cream/70" : "text-forest/70")} role="status">
        {msg || "Product news and new arrivals. No spam."}
      </p>
    </form>
  );
}
