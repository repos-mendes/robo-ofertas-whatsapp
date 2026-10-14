import { recordPrices } from "../db.js";
import type { RawDeal } from "../providers/types.js";

/**
 * Siglas que perderiam sentido em caixa mista ("Usb", "Led"). Tokens com
 * dígito — 128GB, 4K, A54 — já são preservados pela regra abaixo.
 */
const ACRONYMS = new Set([
  "USB", "LED", "LCD", "OLED", "QLED", "SSD", "HD", "HDD", "RAM", "GB", "TB", "MB",
  "NFC", "GPS", "TV", "PC", "HDMI", "RGB", "IPS", "ANC", "BT", "WIFI", "DDR", "CPU",
  "GPU", "USB-C", "XL", "XXL", "PP", "AC", "DC", "LTE", "5G", "4G", "IP", "AI", "IA",
]);

/** Títulos do ML vêm com espaçamento irregular e caixa alta gritada. */
function cleanTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const isShouting = letters.length > 8 && letters === letters.toUpperCase();
  if (!isShouting) return trimmed;

  return trimmed
    .split(" ")
    .map((word) => {
      if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
      // Modelos e capacidades (128GB, 4K, RTX4060) perdem o sentido em caixa mista.
      if (/\d/.test(word)) return word;
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function normalize(deals: readonly RawDeal[]): RawDeal[] {
  return deals.map((deal) => ({ ...deal, title: cleanTitle(deal.title) }));
}

/**
 * Grava TODOS os preços vistos, inclusive os que não virarão post.
 *
 * Esse é o ponto do sistema inteiro: o histórico só tem valor se for coletado
 * indiscriminadamente. Gravar apenas o que já parece oferta produziria uma
 * base enviesada, onde todo preço registrado é baixo e nada mais se destaca.
 */
export function captureHistory(deals: readonly RawDeal[]): void {
  if (deals.length === 0) return;
  recordPrices(deals.map((d) => ({ provider: d.provider, itemId: d.itemId, price: d.price })));
}
