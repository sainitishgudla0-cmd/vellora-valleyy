import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { adminConfigured } from "@/lib/admin-auth";
import { currentAdmin, legacyLoginEnabled } from "@/lib/auth/admin";
import { listSessions, listUsers } from "@/lib/auth/users";
import { onlinePaymentsEnabled } from "@/lib/payments";
import { formatPrice } from "@/lib/format";
import { MOCK_PAYMENT_LABEL } from "@/lib/payments/labels";
import { BUSINESS_INTERESTS } from "@/lib/validation";
import { AdminLogin, AdminLogout, EnquiryStatus, OrderStatusSelect, RemoveTestData, VariantEditor } from "@/components/admin/AdminControls";
import { ChangePasswordForm, SessionsTable, TeamManager } from "@/components/admin/AccountControls";
import { TEST_ENQUIRY_WHERE, TEST_ORDER_WHERE, TEST_SUBSCRIBER_WHERE } from "@/lib/test-data";
import { collectReadiness, listPaymentExceptions } from "@/lib/ops/readiness";
import { listLowStock } from "@/lib/inventory/adjust";
import { OutboxRetryButton, StockEditor } from "@/components/admin/OrderOps";
import { ShippingRuleActions, ShippingRuleForm, TaxRateForm } from "@/components/admin/SettingsControls";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const BASE_TABS = ["orders", "enquiries", "products", "operations"] as const;

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  if (!adminConfigured())
    return (
      <div className="container-site py-20">
        <h1 className="text-display-sm">Admin not configured</h1>
        <p className="mt-3 text-[14px]">Set SESSION_SECRET (24+ characters) in your environment, create the first owner with <code className="rounded bg-dough px-1">npm run admin:bootstrap</code>, then restart the server.</p>
      </div>
    );
  const admin = await currentAdmin();
  if (!admin) return <AdminLogin emailRequired={!legacyLoginEnabled()} />;

  const tabs: readonly string[] = [...BASE_TABS, ...(admin.can("fulfilment:read") ? ["settings"] : []), "account", ...(admin.can("users:manage") ? ["team"] : [])];
  const tab = tabs.includes(sp.tab ?? "") ? sp.tab! : "orders";
  const [orders, enquiries, products, subs, newOrders, newEnq, testOrders, testEnq, testSubs] = await Promise.all([
    tab === "orders" ? db.order.findMany({ orderBy: { createdAt: "desc" }, include: { items: true }, take: 100 }) : Promise.resolve([]),
    tab === "enquiries" ? db.enquiry.findMany({ orderBy: { createdAt: "desc" }, take: 200 }) : Promise.resolve([]),
    tab === "products" ? db.product.findMany({ orderBy: { sortOrder: "asc" }, include: { variants: { orderBy: { sortOrder: "asc" } } } }) : Promise.resolve([]),
    db.subscriber.count(),
    // mock-paid orders are test data, never "to action" (no fulfilment)
    db.order.count({ where: { OR: [{ status: "pending_confirmation" }, { status: "paid", OR: [{ paymentMode: null }, { paymentMode: { not: "mock" } }] }] } }),
    db.enquiry.count({ where: { status: "new" } }),
    db.order.count({ where: TEST_ORDER_WHERE }),
    db.enquiry.count({ where: TEST_ENQUIRY_WHERE }),
    db.subscriber.count({ where: TEST_SUBSCRIBER_WHERE }),
  ]);
  const testTotal = testOrders + testEnq + testSubs;

  return (
    <div className="container-site py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-leaf">Velora Valley</p>
          <h1 className="text-display-sm">Dashboard</h1>
        </div>
        <div className="flex items-center gap-5">
          <span className="text-[12px] text-forest/60" data-testid="admin-identity">
            {admin.legacy ? "Shared password" : `${admin.label} · ${admin.role}`}
          </span>
          {testTotal > 0 && admin.can("testdata:write") && <RemoveTestData count={testTotal} />}
          <AdminLogout />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Stat label="Orders to action" value={newOrders} />
        <Stat label="New enquiries" value={newEnq} />
        <Stat label="Newsletter subscribers" value={subs} />
        <Stat label="Online payments" value={onlinePaymentsEnabled() ? "Enabled" : "Not configured"} />
      </div>

      <nav className="mt-8 flex gap-2 border-b border-forest/15" aria-label="Admin sections">
        {tabs.map((t) => (
          <a
            key={t}
            href={`/admin?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[13px] capitalize ${t === tab ? "border-forest font-medium" : "border-transparent text-forest/60 hover:text-forest"}`}
          >
            {t}
          </a>
        ))}
      </nav>

      {tab === "orders" && (
        <div className="mt-6 overflow-x-auto">
          {orders.length === 0 ? (
            <p className="py-10 text-[14px] text-forest/60">No orders yet.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-[12.5px]">
              <thead className="text-[11px] uppercase tracking-wider text-forest/60">
                <tr>
                  <th className="py-2 pr-3">Order</th>
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 pr-3">Items</th>
                  <th className="py-2 pr-3">Total</th>
                  <th className="py-2 pr-3">Payment</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-forest/10">
                {orders.map((o) => (
                  <tr key={o.id} className="align-top">
                    <td className="py-3 pr-3">
                      <Link href={`/admin/orders/${o.id}`} className="font-medium underline">
                        {o.number}
                      </Link>
                      <br />
                      <span className="text-forest/60">{o.createdAt.toLocaleString("en-IN")}</span>
                    </td>
                    <td className="py-3 pr-3">
                      {o.customerName}
                      <br />
                      <a href={`tel:${o.phone}`} className="underline">
                        {o.phone}
                      </a>{" "}
                      · {o.email}
                      <br />
                      <span className="text-forest/60">
                        {o.addressLine1}
                        {o.addressLine2 ? `, ${o.addressLine2}` : ""}, {o.city}, {o.state} {o.pincode}
                      </span>
                      {o.notes && <p className="mt-1 italic text-forest/70">“{o.notes}”</p>}
                    </td>
                    <td className="py-3 pr-3">
                      {o.items.map((i) => (
                        <div key={i.id}>
                          {i.quantity} × {i.productName} ({i.variantLabel})
                        </div>
                      ))}
                    </td>
                    <td className="py-3 pr-3 font-medium">{formatPrice(o.total)}</td>
                    <td className="py-3 pr-3">
                      {o.paymentMethod === "cod" ? "Pay on delivery" : o.paymentMode === "mock" ? "Online (mock)" : "Razorpay"}
                      <br />
                      <span className={o.paymentStatus === "paid" && o.paymentMode !== "mock" ? "text-leaf" : "text-forest/60"}>{o.paymentStatus}</span>
                      {o.paymentMode === "mock" && (
                        <>
                          <br />
                          <span className="font-medium text-forest">{MOCK_PAYMENT_LABEL}</span>
                        </>
                      )}
                    </td>
                    <td className="py-3">
                      <OrderStatusSelect id={o.id} status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "enquiries" && (
        <div className="mt-6 space-y-3">
          {enquiries.length === 0 && <p className="py-10 text-[14px] text-forest/60">No enquiries yet.</p>}
          {enquiries.map((e) => (
            <div key={e.id} className="rounded-[12px] border border-forest/15 bg-cream-light p-4 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${e.type === "business" ? "bg-gold" : "bg-sage"}`}>{e.type}</span>
                  {e.interest && <span className="mr-2 text-forest/70">{BUSINESS_INTERESTS[e.interest as keyof typeof BUSINESS_INTERESTS] ?? e.interest}</span>}
                  <span className="text-forest/50">{e.createdAt.toLocaleString("en-IN")}</span>
                </div>
                <EnquiryStatus id={e.id} status={e.status} />
              </div>
              <p className="mt-2 font-medium">
                {e.name}
                {e.company && ` — ${e.company}`}
                {e.city && `, ${e.city}`}
              </p>
              <p className="text-forest/70">
                <a href={`mailto:${e.email}`} className="underline">
                  {e.email}
                </a>
                {e.phone && (
                  <>
                    {" · "}
                    <a href={`tel:${e.phone}`} className="underline">
                      {e.phone}
                    </a>
                  </>
                )}
              </p>
              <p className="mt-2 whitespace-pre-wrap">{e.message}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "products" && (
        <div className="mt-6">
          <p className="mb-4 text-[12.5px] text-forest/65">
            Prices are initialised from brochure MRPs. Changes apply immediately to the shop and to new orders. To add products, edit
            <code className="mx-1 rounded bg-dough px-1">src/data/products.ts</code> and run <code className="rounded bg-dough px-1">npm run db:seed</code>.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[12.5px]">
              <thead className="text-[11px] uppercase tracking-wider text-forest/60">
                <tr>
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3">Pack</th>
                  <th className="py-2 pr-3">Barcode</th>
                  <th className="py-2 pr-3">MRP</th>
                  <th className="py-2 pr-3">Selling price · stock</th>
                  <th className="py-2">Units (stock tracking)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-forest/10">
                {products.flatMap((p) =>
                  p.variants.map((v, i) => (
                    <tr key={v.id}>
                      <td className="py-2.5 pr-3 font-medium">{i === 0 ? p.name : ""}</td>
                      <td className="py-2.5 pr-3">{v.label}</td>
                      <td className="py-2.5 pr-3 text-forest/60">{v.sku}</td>
                      <td className="py-2.5 pr-3">{formatPrice(v.mrp)}</td>
                      <td className="py-2.5 pr-3">
                        <VariantEditor id={v.id} price={v.price / 100} inStock={v.inStock} />
                      </td>
                      <td className="py-2.5">
                        {admin.can("inventory:write") ? (
                          <StockEditor id={v.id} tracked={v.trackInventory} stock={v.stockQuantity} reserved={v.reserved} />
                        ) : (
                          <span className="text-[12.5px] text-forest/60">{v.trackInventory ? `${v.stockQuantity - v.reserved} available` : "not tracked"}</span>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "operations" && <OperationsTab admin={admin} />}
      {tab === "settings" && admin.can("fulfilment:read") && <SettingsTab admin={admin} />}
      {tab === "account" && <AccountTab admin={admin} />}
      {tab === "team" && admin.can("users:manage") && <TeamTab currentUserId={admin.userId} />}
    </div>
  );
}

type Admin = NonNullable<Awaited<ReturnType<typeof currentAdmin>>>;
const STATUS_MARK = { ok: "✓", action: "•", blocker: "✗" } as const;
const STATUS_STYLE = { ok: "text-leaf", action: "text-forest", blocker: "font-medium text-[#9b2c2c]" } as const;

/** M11: launch readiness, money that needs a person, undeliverable notifications and low stock. Read-only except retries. */
async function OperationsTab({ admin }: { admin: Admin }) {
  const [report, exceptions, dead, low] = await Promise.all([collectReadiness(), listPaymentExceptions(), db.outboxMessage.findMany({ where: { status: "dead" }, orderBy: { createdAt: "desc" }, take: 50 }), listLowStock()]);
  return (
    <div className="mt-6 space-y-10 text-[13px]">
      <section aria-labelledby="h-readiness">
        <h2 id="h-readiness" className="text-[15px] font-medium">
          Readiness <span className={`ml-2 text-[12px] uppercase tracking-wider ${STATUS_STYLE[report.overall]}`}>{report.overall}</span>
        </h2>
        <ul className="mt-3 space-y-2" data-testid="readiness-list">
          {report.checks.map((c) => (
            <li key={c.id} data-status={c.status}>
              <span className={STATUS_STYLE[c.status]} aria-label={c.status}>
                {STATUS_MARK[c.status]}
              </span>{" "}
              <span className="text-forest/60">[{c.area}]</span> {c.summary}
              {c.next && <span className="block pl-5 text-[12px] text-forest/60">Next: {c.next}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="h-exceptions">
        <h2 id="h-exceptions" className="text-[15px] font-medium">
          Payments needing a person
        </h2>
        {exceptions.length === 0 ? (
          <p className="mt-2 text-forest/60">Nothing to act on.</p>
        ) : (
          <table className="mt-3 w-full min-w-[640px] text-left text-[12.5px]" data-testid="exceptions-table">
            <thead className="text-[11px] uppercase tracking-wider text-forest/60">
              <tr>
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3">What</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2">Since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-forest/10">
              {exceptions.map((e) => (
                <tr key={`${e.kind}-${e.paymentId}-${e.refundId}`}>
                  <td className="py-2 pr-3">
                    <Link href={`/admin/orders/${e.orderId}`} className="underline">
                      {e.orderNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    {e.kind === "orphan_capture" ? "Customer charged, payment not applied: refund it" : e.kind === "flagged_attempt" ? "Awaiting reconciliation with the gateway" : e.kind === "pending_refund" ? "Refund pending over an hour" : "Refund failed"}
                    {e.reason && <span className="text-forest/60"> · {e.reason.replace(/_/g, " ")}</span>}
                  </td>
                  <td className="py-2 pr-3">{formatPrice(e.amountPaise)}</td>
                  <td className="py-2">{new Date(e.since).toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {admin.can("fulfilment:read") && (
      <section aria-labelledby="h-dead">
        <h2 id="h-dead" className="text-[15px] font-medium">
          Notifications that could not be delivered
        </h2>
        {dead.length === 0 ? (
          <p className="mt-2 text-forest/60">None.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {dead.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3">
                <span>
                  {m.template.replace(/_/g, " ")} · {m.subjectType} · {m.lastError ?? "failed"} · {m.createdAt.toLocaleString("en-IN")}
                </span>
                {admin.can("fulfilment:write") && <OutboxRetryButton id={m.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      <section aria-labelledby="h-low">
        <h2 id="h-low" className="text-[15px] font-medium">
          Low stock
        </h2>
        {low.length === 0 ? (
          <p className="mt-2 text-forest/60">No tracked variant is running low.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {low.map((v) => (
              <li key={v.variantId}>
                {v.product} ({v.label}, {v.sku}): {v.available} available ({v.stockQuantity} on hand, {v.reserved} held)
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Business configuration staff enter themselves: shipping rules and GST rates. */
async function SettingsTab({ admin }: { admin: Admin }) {
  const [rules, rates] = await Promise.all([db.shippingRule.findMany({ orderBy: { pincodePrefix: "asc" } }), db.taxRate.findMany({ orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }], take: 500 })]);
  const active = rules.filter((r) => r.active).length;
  return (
    <div className="mt-6 space-y-10 text-[13px]">
      <section aria-labelledby="h-rules">
        <h2 id="h-rules" className="text-[15px] font-medium">
          Shipping rules
        </h2>
        <p className="mt-1 text-[12.5px] text-forest/65">
          {active === 0
            ? "No active rule: every pincode is accepted and delivery charges are confirmed by staff. As soon as one rule is active, only pincodes matching an active rule are served (longest prefix wins; an empty prefix matches everything)."
            : `${active} active rule(s): only matching pincodes are served (longest prefix wins).`}
        </p>
        {rules.length > 0 && (
          <table className="mt-3 w-full min-w-[640px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wider text-forest/60">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Prefix</th>
                <th className="py-2 pr-3">Delivery</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-forest/10">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-3">{r.name}</td>
                  <td className="py-2 pr-3">{r.pincodePrefix || "all"}</td>
                  <td className="py-2 pr-3">{r.serviceable ? `${formatPrice(r.fee)}${r.freeAboveSubtotal ? `, free above ${formatPrice(r.freeAboveSubtotal)}` : ""}` : "not delivered"}</td>
                  <td className="py-2 pr-3">{r.active ? "active" : "inactive"}</td>
                  <td className="py-2">{admin.can("fulfilment:write") && <ShippingRuleActions id={r.id} active={r.active} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {admin.can("fulfilment:write") && (
          <div className="mt-4">
            <ShippingRuleForm />
          </div>
        )}
      </section>

      <section aria-labelledby="h-rates">
        <h2 id="h-rates" className="text-[15px] font-medium">
          GST rates
        </h2>
        <p className="mt-1 text-[12.5px] text-forest/65">Append-only, per HSN code and start date. Enter only rates the accountant has approved; invoices are refused for any item without one.</p>
        {rates.length === 0 ? (
          <p className="mt-2 text-forest/60">No rates recorded.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {rates.map((r) => (
              <li key={r.id}>
                {r.code}: {(r.rateBp / 100).toFixed(2)}% from {r.effectiveFrom.toISOString().slice(0, 10)}
                {r.note && <span className="text-forest/60"> · {r.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {admin.can("tax:write") && (
          <div className="mt-4">
            <TaxRateForm />
          </div>
        )}
      </section>
    </div>
  );
}

/** Your own sessions and password. The shared-password session has neither. */
async function AccountTab({ admin }: { admin: NonNullable<Awaited<ReturnType<typeof currentAdmin>>> }) {
  if (admin.legacy || !admin.userId)
    return (
      <div className="mt-6 max-w-[560px] rounded-[12px] bg-sage p-5 text-[13px]">
        <p className="font-medium">You are signed in with the shared admin password.</p>
        <p className="mt-2 text-forest/70">It has no personal account, sessions or password to manage. Ask an owner to create your account, then sign in with your email.</p>
      </div>
    );
  const sessions = await listSessions(admin.userId);
  return (
    <div className="mt-6 space-y-8">
      <section>
        <h2 className="text-[15px] font-medium">Your sessions</h2>
        <p className="mb-2 text-[12.5px] text-forest/65">Signed in as {admin.label} ({admin.role}). Sessions last 8 hours, or 2 hours if unused. Sign out any you do not recognise.</p>
        <SessionsTable showWho={false} sessions={sessions.map((x) => ({ id: x.id, who: x.email ?? "", userAgent: x.userAgent, createdAt: x.createdAt.toISOString(), lastSeenAt: x.lastSeenAt.toISOString(), current: x.id === admin.sessionId }))} />
      </section>
      <ChangePasswordForm />
    </div>
  );
}

/** Owner only: accounts, everyone's sessions, and the recent audit log. */
async function TeamTab({ currentUserId }: { currentUserId: string | null }) {
  const [users, sessions, audit] = await Promise.all([listUsers(), listSessions(), db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 })]);
  return (
    <div className="mt-6 space-y-10">
      <section>
        <h2 className="mb-3 text-[15px] font-medium">Team</h2>
        <TeamManager
          currentUserId={currentUserId}
          users={users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, locked: !!u.lockedUntil && u.lockedUntil > new Date(), lastLoginAt: u.lastLoginAt?.toISOString() ?? null }))}
        />
      </section>
      <section>
        <h2 className="mb-2 text-[15px] font-medium">Active sessions</h2>
        <SessionsTable showWho sessions={sessions.map((x) => ({ id: x.id, who: x.legacy ? "Shared password" : (x.email ?? ""), userAgent: x.userAgent, createdAt: x.createdAt.toISOString(), lastSeenAt: x.lastSeenAt.toISOString(), current: false }))} />
      </section>
      <section>
        <h2 className="mb-2 text-[15px] font-medium">Recent activity</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wider text-forest/60">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Who</th>
                <th className="py-2 pr-3">Action</th>
                <th className="py-2 pr-3">Result</th>
                <th className="py-2">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-forest/10">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="py-2 pr-3">{a.createdAt.toLocaleString("en-IN")}</td>
                  <td className="py-2 pr-3">{a.actorLabel}</td>
                  <td className="py-2 pr-3">{a.action}</td>
                  <td className="py-2 pr-3">{a.outcome}</td>
                  <td className="py-2 text-forest/60">{a.targetType ? `${a.targetType} ${a.targetId ?? ""}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[12px] bg-sage p-4">
      <p className="text-[11px] uppercase tracking-wider text-forest/60">{label}</p>
      <p className="display mt-1 text-[30px] leading-none">{value}</p>
    </div>
  );
}
