import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentCustomer } from "@/lib/auth/customer";
import { formatPrice } from "@/lib/format";
import { listAddresses } from "@/lib/account/addresses";
import { listOrders } from "@/lib/account/orders";
import { getProfile } from "@/lib/account/profile";
import { findAccountForCustomer } from "@/lib/wholesale/accounts";
import { listBuyerQuotes } from "@/lib/wholesale/quotes";
import { loadQuantityTerms, loadTiers } from "@/lib/wholesale/pricing";
import { ORDER_STATUS_LABEL } from "@/lib/orders";
import { SignIn } from "@/components/account/SignIn";
import { Addresses, ClaimOrders, Privacy, ProfileForm, SignOut } from "@/components/account/AccountControls";
import { BusinessPortal, type PriceItem, type QuoteView } from "@/components/account/BusinessPortal";

export const metadata: Metadata = { title: "Your account", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const TABS = [
  ["orders", "Orders"],
  ["addresses", "Addresses"],
  ["business", "Business"],
  ["privacy", "Privacy"],
] as const;

/** Serialise Dates etc. for client components. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const me = await currentCustomer();
  if (!me) return <SignIn />;
  const tab = TABS.some(([t]) => t === sp.tab) ? sp.tab! : "orders";
  const profile = await getProfile(me.customerId);
  if (!profile) return <SignIn />;

  return (
    <div className="container-site py-10 md:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-leaf">Your account</p>
          <h1 className="text-display-sm">{profile.name || profile.email}</h1>
          <p className="mt-1 text-[12.5px] text-forest/60">{profile.email}</p>
        </div>
        <SignOut />
      </div>

      <nav className="mt-8 flex gap-2 overflow-x-auto border-b border-forest/15" aria-label="Account sections">
        {TABS.map(([t, label]) => (
          <Link key={t} href={`/account?tab=${t}`} aria-current={t === tab ? "page" : undefined} className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-[13px] ${t === tab ? "border-forest font-medium" : "border-transparent text-forest/60 hover:text-forest"}`}>
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        {tab === "orders" && <OrdersTab customerId={me.customerId} />}
        {tab === "addresses" && (
          <div className="space-y-8">
            <ProfileForm name={profile.name} phone={profile.phone} />
            <section>
              <h2 className="mb-3 text-[15px] font-medium">Saved addresses</h2>
              <Addresses addresses={plain(await listAddresses(me.customerId))} />
            </section>
          </div>
        )}
        {tab === "business" && <BusinessTab me={me} profile={profile} />}
        {tab === "privacy" && <Privacy marketing={profile.marketingConsent} />}
      </div>
    </div>
  );
}

async function OrdersTab({ customerId }: { customerId: string }) {
  const { orders } = await listOrders(customerId, { limit: 50 });
  return (
    <div className="space-y-6">
      {orders.length === 0 ? (
        <p className="py-6 text-[13.5px] text-forest/60">You have no orders in your account yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wider text-forest/60">
              <tr>
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3">Placed</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-forest/10">
              {orders.map((o) => (
                <tr key={o.number} data-testid="order-row">
                  <td className="py-3 pr-3">
                    <Link href={`/account/orders/${o.number}`} className="link-underline font-medium">
                      {o.number}
                    </Link>
                  </td>
                  <td className="py-3 pr-3">{o.createdAt.toLocaleDateString("en-IN")}</td>
                  <td className="py-3 pr-3">{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="py-3 pr-3">{formatPrice(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ClaimOrders />
    </div>
  );
}

async function BusinessTab({ me, profile }: { me: { customerId: string; email: string }; profile: { name: string | null; phone: string | null } }) {
  const account = await findAccountForCustomer(me);
  const addresses = await listAddresses(me.customerId);
  const address = addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;
  let priceItems: PriceItem[] = [];
  let quotes: Awaited<ReturnType<typeof listBuyerQuotes>> = [];
  let variants: { id: string; label: string }[] = [];
  if (account?.status === "approved") {
    const rows = await db.variant.findMany({ where: { product: { active: true } }, include: { product: { select: { name: true } } }, orderBy: [{ product: { sortOrder: "asc" } }, { sortOrder: "asc" }] });
    variants = rows.map((v) => ({ id: v.id, label: `${v.product.name} (${v.label})` }));
    const ids = rows.map((v) => v.id);
    const [tiers, terms] = await Promise.all([loadTiers(db, account.priceListId, ids), loadQuantityTerms(db, ids)]);
    priceItems = rows
      .filter((v) => tiers.has(v.id))
      .map((v) => ({ variantId: v.id, product: v.product.name, label: v.label, retailPrice: v.price, moq: terms.get(v.id)?.moq ?? 1, casePack: terms.get(v.id)?.casePack ?? 1, tiers: tiers.get(v.id)! }));
    quotes = await listBuyerQuotes(account.id);
  }
  return (
    <BusinessPortal
      status={account?.status ?? null}
      account={account ? { companyName: account.companyName, gstin: account.gstin, paymentTerms: account.paymentTerms, creditLimit: account.paymentTerms === "credit" ? account.creditLimit : null } : null}
      prefill={{ name: profile.name ?? "", phone: profile.phone ?? "", email: me.email }}
      address={plain(address)}
      quotes={plain(quotes) as unknown as QuoteView[]}
      priceItems={priceItems}
      variants={variants}
    />
  );
}
