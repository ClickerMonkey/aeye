/** Named character references most often seen in web pages, by name. Others are left as written. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  bull: "•", middot: "·", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  deg: "°", times: "×", divide: "÷", plusmn: "±", minus: "−", micro: "µ",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", shy: "­",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", lArr: "⇐",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", check: "✓",
  zwj: "‍", zwnj: "‌", ensp: " ", emsp: " ", thinsp: " ",
  iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", dagger: "†", Dagger: "‡", permil: "‰", prime: "′", Prime: "″",
};

/** A code point as a string, or the replacement character when it is not a valid one. */
function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : "�";
}

/** Decodes html character references: numeric ones (`&#39;`, `&#x27;`) and the common named ones. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));?/g, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    return (name !== undefined ? NAMED_ENTITIES[name] : undefined) ?? match;
  });
}
