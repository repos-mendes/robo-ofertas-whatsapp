import { settings } from "../config.js";
import { lastPost, postsInLast24h } from "../db.js";
import type { ScoredDeal } from "./scoring.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DedupeOutcome {
  selected: ScoredDeal[];
  rejections: Record<string, number>;
}

/**
 * Última barreira antes de publicar. O objetivo não é achar mais ofertas — é
 * proteger o grupo. Um grupo que recebe o mesmo produto três vezes por semana,
 * ou 40 mensagens num dia, perde membros mais rápido do que ganha comissão.
 *
 * Recebe as ofertas já ordenadas por relevância e vai selecionando de cima
 * para baixo até bater algum teto.
 */
export function selectForPosting(deals: readonly ScoredDeal[]): DedupeOutcome {
  const { repostCooldownDays, repostIfPriceDropsPct, maxPostsPerRun, maxPostsPerDay, maxPostsPerSellerPerRun } =
    settings.dedupe;

  const selected: ScoredDeal[] = [];
  const rejections: Record<string, number> = {};
  const reject = (reason: string) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  const remainingToday = Math.max(0, maxPostsPerDay - postsInLast24h());
  if (remainingToday === 0) {
    reject("teto_diario_atingido");
    return { selected, rejections };
  }

  const budget = Math.min(maxPostsPerRun, remainingToday);
  const perSeller = new Map<string, number>();

  for (const deal of deals) {
    if (selected.length >= budget) {
      reject("teto_da_execucao_atingido");
      continue;
    }

    const previous = lastPost(deal.provider, deal.itemId);
    if (previous) {
      const withinCooldown = Date.now() - previous.postedAt < repostCooldownDays * DAY_MS;
      // Repostar dentro do cooldown só se valer a pena de verdade: o preço
      // precisa ter caído mais X% desde a última vez que anunciamos.
      const dropPct = previous.price > 0 ? ((previous.price - deal.price) / previous.price) * 100 : 0;

      if (withinCooldown && dropPct < repostIfPriceDropsPct) {
        reject("ja_publicado_recentemente");
        continue;
      }
    }

    const sellerKey = deal.sellerId ?? "desconhecido";
    const fromSeller = perSeller.get(sellerKey) ?? 0;
    if (fromSeller >= maxPostsPerSellerPerRun) {
      reject("limite_por_vendedor");
      continue;
    }

    perSeller.set(sellerKey, fromSeller + 1);
    selected.push(deal);
  }

  return { selected, rejections };
}
