import type { Metadata } from "next";
import { site } from "@/config/site";
import { onlinePaymentsEnabled } from "@/lib/payments";
import { CheckoutForm } from "@/components/forms/CheckoutForm";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };
export const dynamic = "force-dynamic";

export default function CheckoutPage() {
  return (
    <>
      <PageHeader title="Checkout" script="Nearly yours" crumbs={[{ label: "Cart", href: "/cart" }, { label: "Checkout" }]} />
      <CheckoutForm online={onlinePaymentsEnabled()} cod={site.allowCashOnDelivery} />
    </>
  );
}
