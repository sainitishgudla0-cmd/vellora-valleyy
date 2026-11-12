import { formatInr, formatRate } from "./format";
import type { InvoicePayload } from "./payload";

/**
 * Minimal, dependency-free PDF writer for the tax invoice (M7-T2). Standard Helvetica fonts only, WinAnsi text, A4,
 * no dates or random ids: the same payload always yields the same bytes (asserted in tests).
 */
const W = 595.28;
const H = 841.89;
const M = 36; // margin

// Helvetica advance widths (1/1000 em) for the characters used in aligned figures; other characters use an average.
const WIDTHS: Record<string, number> = { " ": 278, ",": 278, ".": 278, "-": 333, "%": 889, "/": 278, "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556, R: 722, s: 500 };
const width = (t: string, size: number) => ([...t].reduce((s, ch) => s + (WIDTHS[ch] ?? 560), 0) * size) / 1000;

/** Latin-1 safe text: the rupee sign and other non-Latin-1 characters are replaced; parentheses and backslashes are escaped. */
function esc(t: string): string {
  const safe = t.replace(/₹/g, "Rs.").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  return safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

class Page {
  ops: string[] = [];
  text(x: number, y: number, t: string, size = 9, bold = false) {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${(H - y).toFixed(2)} Td (${esc(t)}) Tj ET`);
  }
  right(xr: number, y: number, t: string, size = 9, bold = false) {
    this.text(xr - width(t, size), y, t, size, bold);
  }
  line(x1: number, y1: number, x2: number, y2: number) {
    this.ops.push(`0.5 w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.ops.push(`0.5 w ${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
  }
}

const fit = (t: string, maxChars: number) => (t.length <= maxChars ? t : `${t.slice(0, Math.max(0, maxChars - 1))}.`);
const money = (p: number) => formatInr(p);

/** Column right edges (points) for the numeric columns, and the left edge of the description. */
const COL = { sn: M, desc: M + 22, hsn: 230, qty: 285, rate: 335, taxable: 392, taxPct: 428, tax1: 478, tax2: 528, total: W - M } as const;

export function renderInvoicePdf(p: InvoicePayload): Buffer {
  const pages: Page[] = [];
  const intra = p.supplyType === "intra";
  const newPage = () => {
    const pg = new Page();
    pages.push(pg);
    return pg;
  };

  let pg = newPage();
  pg.text(M, 52, "TAX INVOICE", 16, true);
  pg.right(W - M, 52, `Invoice No: ${p.number}`, 10, true);
  pg.right(W - M, 66, `Date: ${p.issuedAt.slice(0, 10)}`, 9);
  pg.right(W - M, 78, `Order: ${p.order.number}`, 9);
  pg.text(M, 66, "(Original for recipient)", 8);

  // seller / buyer
  const boxTop = 92;
  pg.rect(M, boxTop, (W - 2 * M) / 2 - 4, 92);
  pg.rect(M + (W - 2 * M) / 2 + 4, boxTop, (W - 2 * M) / 2 - 4, 92);
  const s = p.seller;
  pg.text(M + 6, boxTop + 14, "Supplier", 8, true);
  pg.text(M + 6, boxTop + 28, s.legalName, 10, true);
  pg.text(M + 6, boxTop + 41, s.address.line1, 8.5);
  pg.text(M + 6, boxTop + 53, `${s.address.city}, ${s.address.state} ${s.address.pincode}`, 8.5);
  pg.text(M + 6, boxTop + 67, `GSTIN: ${s.gstin}   State code: ${s.stateCode}`, 8.5);
  pg.text(M + 6, boxTop + 79, `FSSAI: ${s.fssai}`, 8.5);
  const bx = M + (W - 2 * M) / 2 + 10;
  const b = p.buyer;
  pg.text(bx, boxTop + 14, "Bill to / Ship to", 8, true);
  pg.text(bx, boxTop + 28, fit(b.company ?? b.name, 44), 10, true);
  if (b.company) pg.text(bx, boxTop + 40, fit(`Attn: ${b.name}`, 50), 8.5);
  pg.text(bx, boxTop + (b.company ? 52 : 41), fit(b.line1, 52), 8.5);
  pg.text(bx, boxTop + (b.company ? 63 : 53), fit(`${b.line2 ? `${b.line2}, ` : ""}${b.city}, ${b.state} ${b.pincode}`, 52), 8.5);
  pg.text(bx, boxTop + 79, b.gstin ? `GSTIN: ${b.gstin}` : "Unregistered / consumer", 8.5);
  pg.text(M, boxTop + 106, `Place of supply: ${p.placeOfSupply.state}${p.placeOfSupply.stateCode ? ` (${p.placeOfSupply.stateCode})` : ""}      Supply: ${intra ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}      Reverse charge: No`, 8.5);

  const header = (page: Page, y: number) => {
    page.line(M, y - 11, W - M, y - 11);
    page.text(COL.sn, y, "#", 8, true);
    page.text(COL.desc, y, "Description", 8, true);
    page.text(COL.hsn, y, "HSN", 8, true);
    page.right(COL.qty, y, "Qty", 8, true);
    page.right(COL.rate, y, "Rate (incl.)", 8, true);
    page.right(COL.taxable, y, "Taxable", 8, true);
    page.right(COL.taxPct, y, "GST", 8, true);
    page.right(COL.tax1, y, intra ? "CGST" : "IGST", 8, true);
    page.right(COL.tax2, y, intra ? "SGST" : "", 8, true);
    page.right(COL.total, y, "Total", 8, true);
    page.line(M, y + 4, W - M, y + 4);
  };

  let y = boxTop + 132;
  header(pg, y);
  y += 17;
  const ROW = 15;
  const rows: { desc: string; hsn: string; qty: string; rate: string; split: { taxableValue: number; cgst: number; sgst: number; igst: number; rateBp: number }; total: number }[] = p.lines.map((l) => ({ desc: l.description, hsn: l.hsCode, qty: String(l.quantity), rate: money(l.unitPrice), split: l, total: l.total }));
  if (p.delivery) rows.push({ desc: p.delivery.description, hsn: "-", qty: "1", rate: money(p.delivery.total), split: p.delivery, total: p.delivery.total });
  rows.forEach((r, i) => {
    if (y > H - 190) {
      pg = newPage();
      y = 60;
      header(pg, y);
      y += 17;
    }
    pg.text(COL.sn, y, String(i + 1), 8.5);
    pg.text(COL.desc, y, fit(r.desc, 34), 8.5);
    pg.text(COL.hsn, y, r.hsn, 8.5);
    pg.right(COL.qty, y, r.qty, 8.5);
    pg.right(COL.rate, y, r.rate, 8.5);
    pg.right(COL.taxable, y, money(r.split.taxableValue), 8.5);
    pg.right(COL.taxPct, y, formatRate(r.split.rateBp), 8.5);
    pg.right(COL.tax1, y, money(intra ? r.split.cgst : r.split.igst), 8.5);
    if (intra) pg.right(COL.tax2, y, money(r.split.sgst), 8.5);
    pg.right(COL.total, y, money(r.total), 8.5);
    y += ROW;
  });
  pg.line(M, y - 6, W - M, y - 6);
  y += 8;
  pg.text(COL.desc, y, "Total", 9, true);
  pg.right(COL.taxable, y, money(p.totals.taxableValue), 9, true);
  pg.right(COL.tax1, y, money(intra ? p.totals.cgst : p.totals.igst), 9, true);
  if (intra) pg.right(COL.tax2, y, money(p.totals.sgst), 9, true);
  pg.right(COL.total, y, money(p.totals.total), 9, true);
  y += 22;
  pg.text(M, y, `Amount payable (inclusive of GST): Rs. ${money(p.totals.total)}`, 10, true);
  y += 18;
  pg.text(M, y, "Prices are inclusive of GST; the tax shown is the part of each price that is GST.", 8);
  pg.text(M, y + 12, "This is a computer generated invoice and needs no signature.", 8);

  // assemble the PDF
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (s: string) => {
    const b = Buffer.from(s, "latin1");
    parts.push(b);
    length += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const pageObjIds = pages.map((_, i) => 5 + i * 2);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((page, i) => {
    const pid = 5 + i * 2;
    const content = page.ops.join("\n");
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pid + 1} 0 R >>`);
    obj(pid + 1, `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });
  const count = 5 + pages.length * 2;
  const xrefAt = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}
