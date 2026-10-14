import type { Deal } from "../providers/types.js";

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

// --- Oferta curada (fluxo da planilha) ---------------------------------------

export interface CuratedOffer {
  /** Título extraído da página do produto (og:title). */
  title: string;
  /** Link de afiliado como está na planilha — publicado sem mexer. */
  link: string;
  /**
   * Preços como texto livre. Quem preenche é o pipeline: planilha quando o
   * curador digitou (cupom, preço negociado), senão o preço lido da página
   * no momento do envio.
   */
  preco: string;
  precoDe: string;
  comentario: string;
  /** Extras lidos da página; ausentes = linhas omitidas. */
  freteGratis?: boolean;
  parcelamento?: string | null;
}

/**
 * Interpreta preço digitado na planilha: "189,90", "R$ 1.234,56", "1234.56".
 * Devolve null para o que não for número — o chamador decide o que fazer.
 */
export function parsePrecoBR(raw: string): number | null {
  const cleaned = raw.replace(/R\$/gi, "").replace(/\s/g, "");
  if (!cleaned) return null;
  // Formato brasileiro: ponto de milhar, vírgula decimal. Sem vírgula, o
  // ponto é tratado como decimal ("1234.56" vindo de célula numérica).
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Mensagem do fluxo curado: sem linha de procedência de desconto, porque aqui
 * quem garante a oferta é o curador humano, não o histórico do robô. O que a
 * planilha não informar simplesmente não aparece — a mensagem mínima é
 * título + link, que já funciona com a prévia do WhatsApp.
 */
export function renderOffer(offer: CuratedOffer): string {
  const preco = parsePrecoBR(offer.preco);
  const precoDe = parsePrecoBR(offer.precoDe);
  const discountPct = preco && precoDe && precoDe > preco ? ((precoDe - preco) / precoDe) * 100 : null;

  const lines: string[] = [];
  lines.push(`${discountPct ? heat(discountPct) : "🔥"} *${offer.title}*`);
  lines.push("");

  if (precoDe) lines.push(`~${brl(precoDe)}~`);
  if (preco) {
    lines.push(`💰 *${brl(preco)}*${discountPct ? `  (-${Math.round(discountPct)}%)` : ""}`);
  } else if (offer.preco.trim()) {
    // Não parseou como número; melhor publicar o que o curador escreveu do que sumir com o preço.
    lines.push(`💰 *${offer.preco.trim()}*`);
  }
  if (offer.parcelamento) lines.push(`💳 ${offer.parcelamento}`);
  if (offer.freteGratis) lines.push("🚚 Frete grátis");
  if (precoDe || preco || offer.preco.trim() || offer.parcelamento || offer.freteGratis) lines.push("");

  if (offer.comentario.trim()) {
    lines.push(`📌 ${offer.comentario.trim()}`);
    lines.push("");
  }

  lines.push(`👉 ${offer.link}`);
  lines.push("");
  lines.push("_Mercado Livre · preço sujeito a alteração_");

  return lines.join("\n");
}

// --- Oferta pontuada (fluxo antigo via API do ML; dormente) -------------------

/** Emoji de destaque proporcional ao tamanho do desconto. */
function heat(discountPct: number): string {
  if (discountPct >= 50) return "🚨";
  if (discountPct >= 30) return "🔥";
  return "💥";
}

/**
 * Formatação do WhatsApp: *negrito*, _itálico_, ~riscado~.
 *
 * A linha de procedência do desconto é intencional e importa: ela diz ao leitor
 * se o "de/por" foi verificado por nós ou apenas repetido do anúncio. É o que
 * separa um grupo confiável de mais um repassador de desconto falso.
 */
export function renderDeal(deal: Deal, storeLabel: string): string {
  const lines: string[] = [];
  const pct = Math.round(deal.discountPct);

  lines.push(`${heat(deal.discountPct)} *${deal.title}*`);
  lines.push("");
  lines.push(`~${brl(deal.referencePrice)}~`);
  lines.push(`💰 *${brl(deal.price)}*  (-${pct}%)`);
  lines.push("");

  if (deal.freeShipping) lines.push("🚚 Frete grátis");

  lines.push(
    deal.basis === "history"
      ? "📉 Menor preço dos últimos 30 dias (verificado por nós)"
      : "🏷️ Desconto informado pelo vendedor",
  );

  lines.push("");
  lines.push(deal.url);
  lines.push("");
  lines.push(`_${storeLabel} · preço sujeito a alteração_`);

  return lines.join("\n");
}
