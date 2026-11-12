import { formatInr } from "@/lib/invoices/format";

/**
 * Notification templates (M7-T6). Pure: (template, variables) -> subject, plain text and HTML. Variables come from the database
 * at send time (src/lib/notify/dispatch.ts), so nothing personal is stored in the outbox. HTML output escapes every variable.
 */
export const TEMPLATES = ["order_placed", "order_confirmed", "order_paid", "order_dispatched", "order_delivered", "order_cancelled", "invoice_issued", "quote_ready"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface TemplateVars {
  brand: string;
  customerName: string;
  orderNumber?: string;
  orderUrl?: string;
  total?: number;
  items?: { name: string; label: string; quantity: number }[];
  courier?: string;
  awb?: string;
  trackingUrl?: string | null;
  invoiceNumber?: string;
  quoteNumber?: string;
  quoteTotal?: number;
  quoteValidUntil?: string;
  paymentMethod?: "cod" | "razorpay";
  paymentStatus?: string;
}

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface Parts {
  subject: string;
  intro: string;
  lines?: string[];
  cta?: { label: string; url: string };
  outro?: string;
}

function parts(t: TemplateName, v: TemplateVars): Parts {
  const order = v.orderNumber ?? "";
  const total = v.total !== undefined ? `Rs. ${formatInr(v.total)}` : "";
  const items = (v.items ?? []).map((i) => `${i.quantity} x ${i.name} (${i.label})`);
  const view = v.orderUrl ? { label: "View your order", url: v.orderUrl } : undefined;
  switch (t) {
    case "order_placed":
      return { subject: `We received your order ${order}`, intro: `Thank you for ordering from ${v.brand}. We have received order ${order}${total ? ` (total ${total})` : ""}.`, lines: items, cta: view, outro: v.paymentMethod === "cod" ? "Our team will confirm your order and any delivery charges before dispatch. You pay on delivery." : "We will confirm your payment shortly." };
    case "order_confirmed":
      return { subject: `Order ${order} is confirmed`, intro: `Good news: order ${order} is confirmed and is being prepared.`, lines: items, cta: view };
    case "order_paid":
      return { subject: `Payment received for order ${order}`, intro: `We have received your payment${total ? ` of ${total}` : ""} for order ${order}.`, cta: view };
    case "order_dispatched":
      return { subject: `Order ${order} is on its way`, intro: `Order ${order} has been dispatched.`, lines: v.courier ? [`Courier: ${v.courier}`, ...(v.awb ? [`Tracking number: ${v.awb}`] : [])] : [], cta: v.trackingUrl ? { label: "Track your shipment", url: v.trackingUrl } : view };
    case "order_delivered":
      return { subject: `Order ${order} was delivered`, intro: `Order ${order} has been delivered. We hope you enjoy it!`, cta: view };
    case "order_cancelled":
      return { subject: `Order ${order} was cancelled`, intro: `Order ${order} has been cancelled.`, outro: v.paymentStatus === "paid" ? "If you had paid, our team will contact you about your refund." : "No payment was taken.", cta: view };
    case "invoice_issued":
      return { subject: `Your tax invoice ${v.invoiceNumber ?? ""} for order ${order}`.replace("  ", " "), intro: `The tax invoice ${v.invoiceNumber ?? ""} for order ${order} is ready${total ? ` (total ${total})` : ""}. You can download it from your account or reply to this email and we will send it.`, cta: view };
    case "quote_ready":
      return { subject: `Your quote ${v.quoteNumber ?? ""} is ready`.replace("  ", " "), intro: `We have priced your quote ${v.quoteNumber ?? ""}${v.quoteTotal !== undefined ? `: total Rs. ${formatInr(v.quoteTotal)} (inclusive of GST)` : ""}.`, lines: v.quoteValidUntil ? [`Valid until ${v.quoteValidUntil}`] : [], outro: "Sign in to your business account to accept or decline it." };
  }
}

export function renderTemplate(t: TemplateName, v: TemplateVars): Rendered {
  const p = parts(t, v);
  const greeting = `Hello ${v.customerName},`;
  const text = [greeting, "", p.intro, ...(p.lines?.length ? ["", ...p.lines.map((l) => `- ${l}`)] : []), ...(p.cta ? ["", `${p.cta.label}: ${p.cta.url}`] : []), ...(p.outro ? ["", p.outro] : []), "", `${v.brand}`].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(p.intro)}</p>`,
    ...(p.lines?.length ? [`<ul>${p.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`] : []),
    ...(p.cta ? [`<p><a href="${escapeHtml(p.cta.url)}">${escapeHtml(p.cta.label)}</a></p>`] : []),
    ...(p.outro ? [`<p>${escapeHtml(p.outro)}</p>`] : []),
    `<p>${escapeHtml(v.brand)}</p>`,
  ].join("\n");
  return { subject: p.subject, text, html };
}
