/**
 * Text for the invoice PDF (M12 VA-07). The PDF uses the standard Helvetica fonts with WinAnsiEncoding (no embedded
 * fonts, so it stays small, dependency-free and byte-for-byte deterministic). WinAnsi cannot show Indian scripts, and the
 * previous writer replaced every character outside Latin-1 with "?", so a buyer who typed their name in Telugu got an
 * invoice addressed to "?????", and "D’Souza – Café" lost its apostrophe and dash.
 *
 * `toPdfText` maps a string to characters WinAnsi can show:
 *  1. NFC normalisation (a decomposed "é" is one glyph, not "e?");
 *  2. the rupee sign becomes "Rs."; typographic quotes, dashes, ellipsis, bullet, euro etc. keep their WinAnsi glyphs
 *     (returned as U+0080..U+009F, which the writer's latin1 encoding turns into the WinAnsi byte);
 *  3. the nine Brahmic scripts of India (Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada,
 *     Malayalam) are transliterated to Latin. They share one Unicode layout (ISCII order), so one table covers all;
 *  4. other Latin letters with diacritics fold to their base letter ("Śrī" → "Sri");
 *  5. anything else is one "?" per character (an emoji is one character, not two UTF-16 units).
 * The result only contains characters it would map to themselves, so applying it twice changes nothing.
 * The invoice payload keeps the original text; only the PDF rendering is transliterated.
 */

const CP1252: Record<string, string> = {
  "€": "\u0080", "‚": "\u0082", "ƒ": "\u0083", "„": "\u0084", "…": "\u0085", "†": "\u0086", "‡": "\u0087", "ˆ": "\u0088", "‰": "\u0089",
  "Š": "\u008a", "‹": "\u008b", "Œ": "\u008c", "Ž": "\u008e", "‘": "\u0091", "’": "\u0092", "“": "\u0093", "”": "\u0094", "•": "\u0095",
  "–": "\u0096", "—": "\u0097", "˜": "\u0098", "™": "\u0099", "š": "\u009a", "›": "\u009b", "œ": "\u009c", "ž": "\u009e", "Ÿ": "\u009f",
};
const CP1252_SLOTS = new Set(Object.values(CP1252));
const EXTRA: Record<string, string> = { "₹": "Rs.", "‐": "-", "‑": "-", "‒": "-", "−": "-", "′": "'", "″": '"', "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ħ": "h", "ı": "i" };
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/;
const SPACE_LIKE = /[\u0000-\u001f\u007f\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

const isLatin1Printable = (c: string) => {
  const n = c.codePointAt(0)!;
  return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff);
};

// --- Indic transliteration -------------------------------------------------------------------------------------
const INDIC_START = 0x0900;
const INDIC_END = 0x0d7f;
/** Blocks whose final inherent vowel is usually silent in names (Hindi/Marathi, Gujarati, Punjabi): राम → Raam. */
const SCHWA_DELETING = new Set([0x0900, 0x0a00, 0x0a80]);
/** South Indian blocks distinguish short/long e and o. */
const DRAVIDIAN = new Set([0x0b80, 0x0c00, 0x0c80, 0x0d00]);

const CONSONANT: Record<number, string> = {
  0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "ng", 0x1a: "ch", 0x1b: "chh", 0x1c: "j", 0x1d: "jh", 0x1e: "ny",
  0x1f: "t", 0x20: "th", 0x21: "d", 0x22: "dh", 0x23: "n", 0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n", 0x29: "n",
  0x2a: "p", 0x2b: "ph", 0x2c: "b", 0x2d: "bh", 0x2e: "m", 0x2f: "y", 0x30: "r", 0x31: "r", 0x32: "l", 0x33: "l", 0x34: "zh",
  0x35: "v", 0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h",
  0x58: "q", 0x59: "kh", 0x5a: "gh", 0x5b: "z", 0x5c: "r", 0x5d: "rh", 0x5e: "f", 0x5f: "y",
};
const TELUGU_CONSONANT: Record<number, string> = { 0x58: "ts", 0x59: "dz", 0x5a: "rr" };
const INDEPENDENT_VOWEL: Record<number, string> = { 0x04: "a", 0x05: "a", 0x06: "aa", 0x07: "i", 0x08: "ii", 0x09: "u", 0x0a: "uu", 0x0b: "ru", 0x0c: "lu", 0x0d: "e", 0x0e: "e", 0x0f: "e", 0x10: "ai", 0x11: "o", 0x12: "o", 0x13: "o", 0x14: "au", 0x60: "ruu", 0x61: "luu" };
const VOWEL_SIGN: Record<number, string> = { 0x3e: "aa", 0x3f: "i", 0x40: "ii", 0x41: "u", 0x42: "uu", 0x43: "ru", 0x44: "ruu", 0x45: "e", 0x46: "e", 0x47: "e", 0x48: "ai", 0x49: "o", 0x4a: "o", 0x4b: "o", 0x4c: "au", 0x62: "lu", 0x63: "luu" };
/** Malayalam chillu letters: a consonant with no vowel. */
const CHILLU: Record<number, string> = { 0x7a: "n", 0x7b: "n", 0x7c: "r", 0x7d: "l", 0x7e: "l", 0x7f: "k" };
const VIRAMA = 0x4d;
const SILENT = new Set([0x00, 0x3a, 0x3b, 0x3c, 0x4e, 0x4f, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x70, 0x71]); // nukta, accents, length marks

function indicPart(block: number, off: number): { kind: "consonant" | "vowel" | "sign" | "virama" | "mark" | "other" | "silent"; text: string } {
  const dravidian = DRAVIDIAN.has(block);
  if (off === VIRAMA) return { kind: "virama", text: "" };
  if (SILENT.has(off)) return { kind: "silent", text: "" };
  if (off === 0x01) return { kind: "mark", text: "n" }; // candrabindu
  if (off === 0x02) return { kind: "mark", text: "m" }; // anusvara (Telugu sunna)
  if (off === 0x03) return { kind: "mark", text: "h" }; // visarga
  if (block === 0x0c00 && TELUGU_CONSONANT[off]) return { kind: "consonant", text: TELUGU_CONSONANT[off] };
  if (CONSONANT[off]) return { kind: "consonant", text: CONSONANT[off] };
  if (INDEPENDENT_VOWEL[off]) return { kind: "vowel", text: dravidian && (off === 0x0f || off === 0x13) ? (off === 0x0f ? "ee" : "oo") : INDEPENDENT_VOWEL[off] };
  if (VOWEL_SIGN[off]) return { kind: "sign", text: dravidian && (off === 0x47 || off === 0x4b) ? (off === 0x47 ? "ee" : "oo") : VOWEL_SIGN[off] };
  if (block === 0x0d00 && CHILLU[off]) return { kind: "other", text: CHILLU[off] };
  if (off >= 0x66 && off <= 0x6f) return { kind: "other", text: String(off - 0x66) };
  if (off === 0x64 || off === 0x65) return { kind: "other", text: "." }; // danda
  return { kind: "silent", text: "" };
}

const isIndic = (cp: number) => cp >= INDIC_START && cp <= INDIC_END;
const isJoiner = (cp: number) => cp === 0x200c || cp === 0x200d;

function transliterateRun(run: number[]): string {
  // `run` is one maximal sequence of Indic code points (and joiners); spaces between words end a run.
  let out = "";
  let pendingA = false;
  let vowels = 0;
  let block = 0;
  const flush = () => {
    if (pendingA) {
      out += "a";
      vowels++;
    }
    pendingA = false;
  };
  for (const cp of run) {
    if (isJoiner(cp)) continue;
    block = cp - ((cp - INDIC_START) % 0x80);
    const p = indicPart(block, (cp - INDIC_START) % 0x80);
    if (p.kind === "consonant") {
      flush();
      out += p.text;
      pendingA = true;
    } else if (p.kind === "sign") {
      out += p.text;
      vowels++;
      pendingA = false;
    } else if (p.kind === "virama") {
      pendingA = false;
    } else if (p.kind === "vowel") {
      flush();
      out += p.text;
      vowels++;
    } else if (p.kind === "mark") {
      flush();
      out += p.text;
    } else if (p.kind === "other") {
      flush();
      out += p.text;
    }
  }
  if (pendingA && !(SCHWA_DELETING.has(block) && vowels > 0)) out += "a";
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

function mapChar(c: string): string {
  if (isLatin1Printable(c) || CP1252_SLOTS.has(c)) return c;
  if (CP1252[c]) return CP1252[c];
  if (EXTRA[c] !== undefined) return EXTRA[c];
  if (ZERO_WIDTH.test(c)) return "";
  if (SPACE_LIKE.test(c)) return " ";
  const folded = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (folded && [...folded].every(isLatin1Printable)) return folded;
  return "?";
}

export function toPdfText(input: string): string {
  const chars = [...input.normalize("NFC")];
  let out = "";
  for (let i = 0; i < chars.length; ) {
    const cp = chars[i].codePointAt(0)!;
    if (isIndic(cp)) {
      const run: number[] = [];
      while (i < chars.length) {
        const c = chars[i].codePointAt(0)!;
        if (!isIndic(c) && !isJoiner(c)) break;
        run.push(c);
        i++;
      }
      out += transliterateRun(run);
      continue;
    }
    out += mapChar(chars[i]);
    i++;
  }
  return out;
}
