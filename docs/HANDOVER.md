# Staff handover — running Velora Valley day to day

For the business owner and staff (M11 P7-T4). Technical operators: `RELEASE.md` and `RUNBOOK-DATABASE.md`. Everything here happens in the admin dashboard at `/admin`; nothing needs a terminal except where marked **(operator)**.

## Accounts and roles
- Everyone signs in with **their own email and password**. The old shared password is read-only and does not work at all on the live site.
- Roles: **owner** (everything, including staff accounts, refunds and GST rates), **operations** (orders, payments received on delivery, shipments, invoices, stock, shipping rules, wholesale), **catalog** (prices, stock, wholesale price lists), **viewer** (read only).
- An owner adds people under **Team**, can reset their password, change their role or deactivate them. Every change is in the activity log on the same tab.
- Locked out as the only owner? **(operator)** `RELEASE.md` A1b "Owner recovery".

## Every morning (10 minutes)
1. **Operations** tab, top section *Sales* (M12): orders placed, order value, money collected and cancellations for today, the last 7 days and this month (Indian calendar days; test orders left out), plus the month's top products. Then *Readiness*: anything marked ✗ needs attention today; • items are known open set-up work.
2. *Payments needing a person*:
   - "Customer charged, payment not applied: refund it" — the customer paid but the order had already expired or was cancelled. An owner opens the order and refunds the full amount (see *Refunds*).
   - "Awaiting reconciliation" — usually settles by itself within 15 minutes; if it stays for hours, tell the operator.
   - "Refund pending over an hour" / "Refund failed" — check the order page; a failed refund can be requested again once the reason is known.
3. *Notifications that could not be delivered*: fix the cause (wrong email address, email provider problem), then **Retry**.
4. *Low stock*: reorder or adjust counts.
5. **Orders** tab: the counter "Orders to action" shows new pay-on-delivery orders and paid online orders.

## Handling an order
Open it from the **Orders** tab (click the order number). The order page shows the customer, items, payments, refunds, shipments, invoice and the full history.
1. **Confirm** (pay-on-delivery orders): status menu at the top right → *confirmed*. Staff confirm delivery charges with the customer before dispatch if no shipping rule applies.
2. **Ship**: *Shipments* → courier, AWB, tracking link → *Add shipment*. Then set the order status to *dispatched* (the customer's dispatch email carries the tracking details). Update the shipment as it moves (*picked up*, *in transit*, *delivered*).
3. **Delivered**: set the order status to *delivered*.
4. **Money received on delivery** (owners): *Record a pay-on-delivery collection* → the full amount received, the method (cash, UPI, bank transfer, cheque, card on delivery), the receipt/UTR/reference and a note. The amount must equal the order total; one reference can only be used once; the record cannot be changed afterwards. Operations staff see the order but cannot record money until the owner decides they may (ADR 0024).
5. **Invoice**: *Issue tax invoice*. If it says a GST rate is missing it lists the HSN codes; an owner adds the accountant-approved rate under **Settings** first. Once an order is invoiced it cannot be cancelled (credit notes are not built yet).
6. **Cancel**: status → *cancelled* with a reason. Stock held for the order is released automatically. An order already paid online then needs a refund.

## Refunds (owners only)
On the order page, *Refund*: reason, amount (empty = everything still refundable) → *Refund through the gateway*. The money goes back through Razorpay; the status updates by itself (pending → processed). Never mark an online payment "refunded" by hand: the system refuses it. A refund made directly in the Razorpay dashboard appears here automatically.

## Stock
- **Products** tab, last column: *Start tracking* with the counted opening stock, then *Adjust* with a reason (delivery received +, damaged −). Tracked products cannot be oversold; untracked ones use the old in-stock tick box.
- Whole-catalogue count at launch or stocktake: **(operator)** `RELEASE.md` A8 (`inventory:import` from a count sheet).

## Delivery areas and fees
**Settings** → *Shipping rules*. With no active rule, every pincode is accepted and staff confirm charges. As soon as one rule is active, **only pincodes matching an active rule can order**, so add the full set before activating (a rule with an empty prefix matches everything and can carry a default fee).

## GST
**Settings** → *GST rates*: only rates the accountant has approved, per HSN code and start date (they cannot be edited, only superseded by a later date). The accountant's checklist: `RELEASE.md` A9.

## Wholesale
**Wholesale** tab (owner, operations): each business application shows company, GSTIN and contact. Set the price list, payment terms (prepaid or credit with a limit) and *Approve*, or *Reject*; approved accounts can be suspended or closed later. *Open quote requests*: enter a unit price per line (never above MRP), an optional delivery fee and validity, then *Send quote*; the buyer accepts it in their account. Price lists, quantity tiers and minimum order quantities are still set through the admin API (`API-CONTRACTS.md` "Wholesale").

## When something looks wrong
- A customer says they paid but the order shows unpaid: check *Payments needing a person*; wait 15 minutes for reconciliation; if still unpaid, tell the operator with the order number (never mark it paid by hand: online payments are confirmed by the gateway only).
- The site cannot take payments: the operator can switch to pay-on-delivery only in minutes (`RELEASE.md` C4); nothing already paid is affected.
- Write down what happened and when; the activity log (Team tab) records who did what.
