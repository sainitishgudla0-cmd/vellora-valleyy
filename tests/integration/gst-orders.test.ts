/** M7-T1/T3: GST snapshot per order line at creation, rate lookup by date and HSN, shipping fee and serviceability in createOrder. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createOrder, OrderError } from "@/lib/orders";
import { cleanupInventoryFixtures, createInventoryVariant } from "../support/inventory";
import { cleanupFulfilmentFixtures, fulfilmentEnv, placeCod, setRate, SHIP_TO_AP, SHIP_TO_KA } from "../support/fulfilment";

beforeEach(async () => {
  fulfilmentEnv();
  await cleanupFulfilmentFixtures();
});
afterAll(async () => {
  await cleanupFulfilmentFixtures();
  await cleanupInventoryFixtures();
  await db.$disconnect();
});

const items = (orderId: string) => db.orderItem.findMany({ where: { orderId }, orderBy: { id: "asc" } });

describe("GST snapshot at order creation", () => {
  it("splits a GST-inclusive line into taxable value + CGST/SGST for an order inside Andhra Pradesh", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 }); // Rs 105.00 incl. GST
    await setRate("0802", 500);
    const o = await placeCod(v.variantId, { quantity: 3 });
    const [line] = await items(o.id);
    expect(line).toMatchObject({ hsCode: "0802", gstRateBp: 500, taxableValue: 30000, cgst: 750, sgst: 750, igst: 0, lineTotal: 31500 });
    expect(o).toMatchObject({ supplyType: "intra", deliveryGstRateBp: 0, deliveryTaxable: 0, deliveryCgst: 0, deliverySgst: 0, deliveryIgst: 0 });
  });

  it("uses IGST for an order shipped to another state", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    await setRate("0802", 500);
    const o = await placeCod(v.variantId, { ship: SHIP_TO_KA, quantity: 3 });
    expect((await items(o.id))[0]).toMatchObject({ taxableValue: 30000, cgst: 0, sgst: 0, igst: 1500 });
    expect(o.supplyType).toBe("inter");
  });

  it("every line is exact to the paisa and the parts always add up (also enforced by the database)", async () => {
    const a = await createInventoryVariant({ tracked: false, price: 4999 });
    const b = await createInventoryVariant({ tracked: false, price: 12345 });
    await setRate("0802", 1200);
    const o = await createOrder({ ...SHIP_TO_AP, paymentMethod: "cod", items: [{ variantId: a.variantId, quantity: 7 }, { variantId: b.variantId, quantity: 3 }] });
    for (const l of await items(o.id)) expect(l.taxableValue! + l.cgst! + l.sgst! + l.igst!).toBe(l.lineTotal);
    const sum = (await items(o.id)).reduce((s, l) => s + l.taxableValue! + l.cgst! + l.sgst! + l.igst!, 0);
    expect(sum).toBe(o.subtotal);
    await expect(db.orderItem.update({ where: { id: (await items(o.id))[0].id }, data: { cgst: { increment: 1 } } })).rejects.toThrow(/OrderItem_gst_snapshot_check/);
    await expect(db.orderItem.update({ where: { id: (await items(o.id))[0].id }, data: { igst: 5 } })).rejects.toThrow(/OrderItem_gst_snapshot_check/); // CGST and IGST can never coexist
  });

  it("taxes the delivery charge at the DELIVERY rate when there is a fee", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    await setRate("0802", 500);
    await setRate("DELIVERY", 1800);
    await db.shippingRule.create({ data: { name: "All", pincodePrefix: "", fee: 5900 } });
    const o = await placeCod(v.variantId);
    expect(o.deliveryFee).toBe(5900);
    expect(o).toMatchObject({ deliveryGstRateBp: 1800, deliveryTaxable: 5000, deliveryCgst: 450, deliverySgst: 450, deliveryIgst: 0 });
    expect(o.total).toBe(o.subtotal + 5900);
  });

  it("without a configured rate the order still works and the snapshot stays empty (filled at invoice time)", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    const o = await placeCod(v.variantId);
    expect(o.status).toBe("pending_confirmation");
    expect((await items(o.id))[0]).toMatchObject({ gstRateBp: null, taxableValue: null, cgst: null, sgst: null, igst: null, hsCode: "0802" });
    expect(o.supplyType).toBe("intra");
    // a rate set later does not rewrite an existing order
    await setRate("0802", 500);
    expect((await items(o.id))[0].gstRateBp).toBeNull();
  });

  it("looks the rate up by effective date, so a later change does not touch earlier orders; and by HSN specificity", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    const hsn = (await db.variant.findUniqueOrThrow({ where: { id: v.variantId } })).hsCode;
    expect(hsn).toBe("0802");
    await setRate("0802", 500, "2020-01-01");
    await setRate("0802", 1800, "2099-01-01"); // in the future: not in force yet
    expect((await items((await placeCod(v.variantId)).id))[0].gstRateBp).toBe(500);
    await setRate("0802", 1200, "2021-01-01"); // newer than the first, still in the past: wins
    expect((await items((await placeCod(v.variantId)).id))[0].gstRateBp).toBe(1200);
    await db.variant.update({ where: { id: v.variantId }, data: { hsCode: "08025200" } });
    await setRate("080252", 2800, "2020-01-01");
    expect((await items((await placeCod(v.variantId)).id))[0]).toMatchObject({ gstRateBp: 2800, hsCode: "08025200" }); // the 6-digit rate beats the 4-digit one
    await setRate("08025200", 0, "2020-01-01");
    expect((await items((await placeCod(v.variantId)).id))[0].gstRateBp).toBe(0); // the exact code beats both
  });

  it("the snapshot is frozen: the catalogue HSN changing later does not alter an existing line", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    await setRate("0802", 500);
    const o = await placeCod(v.variantId);
    await db.variant.update({ where: { id: v.variantId }, data: { hsCode: "99999999" } });
    expect((await items(o.id))[0]).toMatchObject({ hsCode: "0802", gstRateBp: 500 });
  });

  it("retail response shape and totals are unchanged by tax (prices stay GST-inclusive)", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 10500 });
    await setRate("0802", 500);
    const o = await placeCod(v.variantId, { quantity: 2 });
    expect(o.subtotal).toBe(21000);
    expect(o.total).toBe(21000 + o.deliveryFee);
  });
});

describe("rate table integrity", () => {
  it("is append-only by key (one rate per code and date) and bounded", async () => {
    await setRate("0802", 500, "2026-04-01");
    await expect(db.taxRate.create({ data: { code: "0802", rateBp: 600, effectiveFrom: new Date("2026-04-01T00:00:00Z") } })).rejects.toThrow(/Unique constraint/);
    await expect(db.taxRate.create({ data: { code: "0802", rateBp: 6000, effectiveFrom: new Date("2026-05-01T00:00:00Z") } })).rejects.toThrow(/TaxRate_values_check/);
    await expect(db.taxRate.create({ data: { code: "", rateBp: 500, effectiveFrom: new Date("2026-05-01T00:00:00Z") } })).rejects.toThrow(/TaxRate_values_check/);
  });
});

describe("shipping rules in createOrder (M7-T3)", () => {
  it("legacy mode: no rules means every pincode is served at the site default fee", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const o = await placeCod(v.variantId, { ship: { ...SHIP_TO_KA, pincode: "682001" } });
    expect(o.deliveryFee).toBe(0);
  });

  it("with rules: the fee comes from the longest matching prefix, with a free-shipping threshold", async () => {
    const v = await createInventoryVariant({ tracked: false, price: 20000 });
    await db.shippingRule.createMany({ data: [{ name: "All India", pincodePrefix: "", fee: 9900 }, { name: "Rayalaseema", pincodePrefix: "51", fee: 4900, freeAboveSubtotal: 50000 }, { name: "Anantapur", pincodePrefix: "515", fee: 2500 }] });
    expect((await placeCod(v.variantId, { quantity: 1 })).deliveryFee).toBe(2500); // 515001 -> Anantapur
    expect((await placeCod(v.variantId, { ship: { ...SHIP_TO_AP, pincode: "516001" }, quantity: 1 })).deliveryFee).toBe(4900); // 51 -> Rayalaseema
    expect((await placeCod(v.variantId, { ship: { ...SHIP_TO_AP, pincode: "516001" }, quantity: 3 })).deliveryFee).toBe(0); // 60,000 >= 50,000: free
    expect((await placeCod(v.variantId, { ship: SHIP_TO_KA, quantity: 1 })).deliveryFee).toBe(9900); // catch-all
  });

  it("refuses an unserviceable pincode with a 422 and creates nothing (no stock held, no order)", async () => {
    const v = await createInventoryVariant({ stock: 10, price: 20000 });
    await db.shippingRule.createMany({ data: [{ name: "Andhra only", pincodePrefix: "51", fee: 0 }] });
    await expect(placeCod(v.variantId, { ship: SHIP_TO_KA })).rejects.toMatchObject({ status: 422, message: "Sorry, we do not deliver to this pincode yet." });
    await db.shippingRule.create({ data: { name: "Island", pincodePrefix: "682", serviceable: false } });
    await db.shippingRule.update({ where: { pincodePrefix: "51" }, data: { pincodePrefix: "" } });
    await expect(placeCod(v.variantId, { ship: { ...SHIP_TO_KA, pincode: "682001" } })).rejects.toBeInstanceOf(OrderError);
    expect(await db.order.count({ where: { items: { some: { variantId: v.variantId } } } })).toBe(0);
    expect((await db.variant.findUniqueOrThrow({ where: { id: v.variantId } })).reserved).toBe(0);
    expect((await placeCod(v.variantId, { ship: SHIP_TO_KA, quantity: 1 })).deliveryFee).toBe(0); // the catch-all still serves everything else
  });

  it("inactive rules are ignored; deactivating the last rule returns to legacy mode", async () => {
    const v = await createInventoryVariant({ tracked: false });
    const r = await db.shippingRule.create({ data: { name: "Andhra only", pincodePrefix: "51", fee: 1000, active: false } });
    expect((await placeCod(v.variantId, { ship: SHIP_TO_KA })).deliveryFee).toBe(0); // inactive: legacy, everywhere
    await db.shippingRule.update({ where: { id: r.id }, data: { active: true } });
    await expect(placeCod(v.variantId, { ship: SHIP_TO_KA })).rejects.toMatchObject({ status: 422 });
  });

  it("the database refuses nonsensical rules", async () => {
    await expect(db.shippingRule.create({ data: { name: "x", pincodePrefix: "12a" } })).rejects.toThrow(/ShippingRule_values_check/);
    await expect(db.shippingRule.create({ data: { name: "x", pincodePrefix: "1234567" } })).rejects.toThrow(/ShippingRule_values_check/);
    await expect(db.shippingRule.create({ data: { name: "x", pincodePrefix: "1", fee: -1 } })).rejects.toThrow(/ShippingRule_values_check/);
    await expect(db.shippingRule.create({ data: { name: "x", pincodePrefix: "1", freeAboveSubtotal: 0 } })).rejects.toThrow(/ShippingRule_values_check/);
  });
});
