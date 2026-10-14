import { settings } from "../config.js";
import { priceStats } from "../db.js";
import type { DiscountBasis, RawDeal } from "../providers/types.js";

export interface ScoredDeal extends RawDeal {
  discountPct: number;
  basis: DiscountBasis;
  referencePrice: number;
}

export interface ScoreOutcome {
  approved: ScoredDeal[];
  /** Contagem por motivo de rejeição — vai para o log, ajuda a calibrar limiares. */
  rejections: Record<string, number>;
}

/**
 * Tolerância para a comparação "é o menor preço da janela". O preço atual já
 * está no histórico quando esta função roda, então min <= price sempre; a
 * folga evita que ruído de ponto flutuante reprove um empate legítimo.
 */
const FLOAT_SLACK = 1.0001;

/**
 * Decide o que é oferta de verdade.
 *
 * Há dois regimes. Com histórico suficiente, o desconto é medido contra a
 * MEDIANA dos últimos N dias e o item ainda precisa estar no menor preço da
 * janela — é o critério confiável. Sem histórico (robô recém-instalado), cai
 * no `original_price` da loja com um limiar mais alto, porque esse número é
 * declarado pelo vendedor e costuma ser inflado para simular desconto.
 */
export function scoreDeals(deals: readonly RawDeal[]): ScoreOutcome {
  const { minPrice, maxPrice, minDiscountPct, historyWindowDays, minHistoryPoints, bootstrapMinDiscountPct, requireFreeShipping } =
    settings.scoring;

  const approved: ScoredDeal[] = [];
  const rejections: Record<string, number> = {};
  const reject = (reason: string) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  for (const deal of deals) {
    if (deal.price < minPrice || deal.price > maxPrice) {
      reject("fora_da_faixa_de_preco");
      continue;
    }
    if (requireFreeShipping && !deal.freeShipping) {
      reject("sem_frete_gratis");
      continue;
    }

    const stats = priceStats(deal.provider, deal.itemId, historyWindowDays);
    const hasHistory = stats !== null && stats.points >= minHistoryPoints;

    if (hasHistory) {
      if (deal.price > stats.min * FLOAT_SLACK) {
        reject("nao_e_o_menor_preco_da_janela");
        continue;
      }
      if (stats.median <= 0) {
        reject("mediana_invalida");
        continue;
      }

      const discountPct = ((stats.median - deal.price) / stats.median) * 100;
      if (discountPct < minDiscountPct) {
        reject("desconto_insuficiente_vs_historico");
        continue;
      }

      approved.push({ ...deal, discountPct, basis: "history", referencePrice: stats.median });
      continue;
    }

    // --- Regime de bootstrap ---
    if (deal.originalPrice === null) {
      reject("sem_historico_e_sem_preco_de");
      continue;
    }

    const discountPct = ((deal.originalPrice - deal.price) / deal.originalPrice) * 100;
    if (discountPct < bootstrapMinDiscountPct) {
      reject("desconto_insuficiente_vs_preco_de");
      continue;
    }

    approved.push({ ...deal, discountPct, basis: "original_price", referencePrice: deal.originalPrice });
  }

  // Ofertas validadas por histórico vêm primeiro: entre um desconto de 40%
  // declarado pelo vendedor e um de 20% comprovado por nós, o segundo vale mais.
  approved.sort((a, b) => {
    if (a.basis !== b.basis) return a.basis === "history" ? -1 : 1;
    return b.discountPct - a.discountPct;
  });

  return { approved, rejections };
}
