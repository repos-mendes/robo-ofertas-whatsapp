import { env, settings } from "../config.js";
import { markPosted } from "../db.js";
import { logger } from "../logger.js";
import type { OutgoingOffer } from "../channels/types.js";
import { parsePrecoBR, renderOffer } from "../message/template.js";
import { channels } from "../registry.js";
import { scrapeProduct } from "../scrape/product.js";
import { fetchSheetRows, markSheetStatus, type SheetRow } from "../sheet/client.js";

/**
 * Fluxo curado: quem decide o que é oferta é o humano que preenche a planilha.
 * O robô só enriquece (título + foto via scraping) e publica. Não há scoring
 * nem afiliação — o link da planilha já vem afiliado.
 */

/** Provider fixo na tabela `posted`, mantida só como histórico do que foi enviado. */
const SHEET_PROVIDER = "planilha";

export interface RunOptions {
  /** Sobrescreve DRY_RUN do .env para esta execução. */
  dryRun?: boolean;
  /** Monta as ofertas e para antes de publicar. Usado por GET /deals. */
  preview?: boolean;
}

export interface OfferPreview {
  row: number;
  link: string;
  title: string;
  caption: string;
  hasImage: boolean;
}

export interface RunSummary {
  startedAt: string;
  durationMs: number;
  /** Linhas com link na planilha. */
  rowsInSheet: number;
  /** Linhas ainda não enviadas (coluna de status vazia). */
  pending: number;
  /** Ofertas montadas com sucesso (scraping ok). */
  prepared: number;
  published: number;
  failed: number;
  /** Linhas cujo scraping falhou; ficam na planilha para a próxima tentativa. */
  scrapeFailures: Array<{ row: number; link: string; error: string }>;
  dryRun: boolean;
  preview: boolean;
  offers: OfferPreview[];
}

let running = false;

/** Última prévia calculada, servida por GET /deals/last sem refazer o ciclo. */
let lastPreview: OfferPreview[] = [];

export function getLastPreview(): OfferPreview[] {
  return lastPreview;
}

function isPending(row: SheetRow): boolean {
  // Única defesa contra reenvio: o status escrito na planilha. Limpar a célula
  // de status reenvia a linha — é o jeito do curador repetir uma oferta.
  return row.status.trim() === "";
}

/**
 * Um ciclo completo: ler planilha → filtrar pendentes → extrair título/foto →
 * montar mensagem → publicar → marcar (banco + planilha).
 *
 * Protegido contra reentrância: o cron e uma chamada manual a POST /run podem
 * coincidir, e dois ciclos simultâneos publicariam a mesma linha duas vezes.
 */
export async function runCycle(options: RunOptions = {}): Promise<RunSummary> {
  if (running) throw new Error("Já existe um ciclo em execução");
  running = true;

  const startedAt = new Date();
  const dryRun = options.dryRun ?? env.DRY_RUN;
  const preview = options.preview ?? false;

  try {
    // --- Planilha -----------------------------------------------------------
    const rows = await fetchSheetRows();
    const pendingRows = rows.filter(isPending).slice(0, settings.dedupe.maxPostsPerRun);

    logger.info({ rowsInSheet: rows.length, pending: pendingRows.length }, "Planilha lida");

    // --- Enriquecimento -----------------------------------------------------
    const offers: OutgoingOffer[] = [];
    const scrapeFailures: RunSummary["scrapeFailures"] = [];

    for (const row of pendingRows) {
      try {
        const product = await scrapeProduct(row.link);

        // Planilha preenchida vence (cupom, preço negociado); vazia, vale o
        // preço lido da página AGORA — preço digitado ontem pode ter mudado.
        const pagePrice = product.price;
        if (pagePrice && row.preco.trim()) {
          const sheetPrice = parsePrecoBR(row.preco);
          if (sheetPrice && Math.abs(sheetPrice - pagePrice.current) / pagePrice.current > 0.01) {
            logger.warn(
              { row: row.row, planilha: sheetPrice, pagina: pagePrice.current },
              "Preço da planilha difere do preço atual da página; publicando o da planilha",
            );
          }
        }

        const caption = renderOffer({
          title: product.title,
          link: row.link,
          preco: row.preco.trim() || (pagePrice ? String(pagePrice.current) : ""),
          precoDe: row.precoDe.trim() || (pagePrice?.previous ? String(pagePrice.previous) : ""),
          comentario: row.comentario,
          freteGratis: pagePrice?.freeShipping ?? false,
          parcelamento: pagePrice?.installments ?? null,
        });
        offers.push({ row: row.row, link: row.link, title: product.title, caption, image: product.image });
      } catch (err) {
        // Linha problemática não trava as demais; sem status, ela volta no próximo ciclo.
        scrapeFailures.push({ row: row.row, link: row.link, error: (err as Error).message });
        logger.error({ row: row.row, link: row.link, err: (err as Error).message }, "Scraping falhou");
      }
    }

    lastPreview = offers.map((o) => ({
      row: o.row,
      link: o.link,
      title: o.title,
      caption: o.caption,
      hasImage: o.image !== null,
    }));

    if (preview) {
      return summarize({ startedAt, rows, pendingRows, offers, published: 0, failed: 0, scrapeFailures, dryRun, preview });
    }

    // --- Publicação ---------------------------------------------------------
    let published = 0;
    let failed = 0;
    const sentRows = new Set<number>();

    for (const channel of channels) {
      try {
        const result = await channel.publish(offers, { dryRun });
        published += result.sent;
        failed += result.failed;
        for (const row of result.sentRows) sentRows.add(row);
      } catch (err) {
        failed += offers.length;
        logger.error({ channel: channel.id, err: (err as Error).message }, "Canal falhou");
      }
    }

    // --- Marcação -----------------------------------------------------------
    // Em DRY_RUN nada é marcado — nem no banco, nem na planilha — senão o
    // primeiro ciclo real acharia que já divulgou tudo e ficaria mudo.
    if (!dryRun) {
      const stamp = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      for (const offer of offers) {
        if (!sentRows.has(offer.row)) continue;
        const row = pendingRows.find((r) => r.row === offer.row);
        markPosted(SHEET_PROVIDER, offer.link, (row && parsePrecoBR(row.preco)) ?? 0);
        await markSheetStatus(offer.row, `ENVIADO ✅ ${stamp}`);
      }
    }

    return summarize({ startedAt, rows, pendingRows, offers, published, failed, scrapeFailures, dryRun, preview });
  } finally {
    running = false;
  }
}

function summarize(input: {
  startedAt: Date;
  rows: SheetRow[];
  pendingRows: SheetRow[];
  offers: OutgoingOffer[];
  published: number;
  failed: number;
  scrapeFailures: RunSummary["scrapeFailures"];
  dryRun: boolean;
  preview: boolean;
}): RunSummary {
  return {
    startedAt: input.startedAt.toISOString(),
    durationMs: Date.now() - input.startedAt.getTime(),
    rowsInSheet: input.rows.length,
    pending: input.pendingRows.length,
    prepared: input.offers.length,
    published: input.published,
    failed: input.failed,
    scrapeFailures: input.scrapeFailures,
    dryRun: input.dryRun,
    preview: input.preview,
    offers: lastPreview,
  };
}
