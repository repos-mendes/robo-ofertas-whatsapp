import { settings } from "../../config.js";
import { logger } from "../../logger.js";
import type { RawDeal } from "../types.js";
import { getAccessToken, PROVIDER_ID } from "./auth.js";

const API_BASE = "https://api.mercadolibre.com";

/**
 * ATENÇÃO — por que a coleta é indireta.
 *
 * O endpoint /sites/{site}/search, que era a base natural deste robô, foi
 * desativado pelo ML: responde 403 para qualquer chamada, inclusive sem token.
 * O /items/{id} também é 403 para itens de terceiros. Sobrou um caminho só, e
 * ele passa pelo CATÁLOGO:
 *
 *   descoberta   →  /highlights/{site}/category/{cat}   (mais vendidos)
 *                →  /trends/{site}/{cat} + /products/search   (termos em alta)
 *   preço        →  /products/{id}/items                (única fonte de preço)
 *   título       →  /products/{id}                      (só quando falta)
 *
 * Consequência prática: uma chamada por produto em vez de 50 produtos por
 * chamada. Por isso existem os tetos em config.json — sem eles um ciclo levaria
 * dezenas de minutos e bateria no rate limit.
 */

/** Pausa entre chamadas para não esbarrar no rate limit da aplicação. */
const REQUEST_SPACING_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A leitura do JSON do ML é deliberadamente tolerante: campo que não vier vira
 * null e o produto segue vivo, em vez de derrubar a coleta inteira por causa de
 * uma mudança de schema.
 */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function fetchJson(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    // Desde 2025 o ML exige token em TODAS as chamadas, inclusive nas públicas.
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} em ${path}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

// --- Descoberta de produtos --------------------------------------------------

/** Produto do catálogo ainda sem preço: só o que basta para ir buscar as ofertas. */
interface CatalogProduct {
  id: string;
  /** Vem preenchido pelo /products/search; pelo highlights só temos o id. */
  name: string | null;
  thumbnail: string | null;
}

/** Mais vendidos da categoria. Devolve ~15 a 20 ids, e ignora limit/offset. */
async function fetchHighlights(categoryId: string): Promise<CatalogProduct[]> {
  const payload = (await fetchJson(`/highlights/${settings.search.siteId}/category/${categoryId}`)) as {
    content?: Array<{ id?: unknown; type?: unknown }>;
  };

  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    // USER_PRODUCT aponta para anúncio de vendedor, que cai no /items/{id}
    // bloqueado. Só PRODUCT (catálogo) é utilizável.
    .filter((entry) => entry.type === "PRODUCT")
    .map((entry) => asString(entry.id))
    .filter((id): id is string => id !== null)
    .map((id) => ({ id, name: null, thumbnail: null }));
}

/** Termos em alta da categoria, usados como palavra-chave no catálogo. */
async function fetchTrendKeywords(categoryId: string, limit: number): Promise<string[]> {
  const payload = (await fetchJson(`/trends/${settings.search.siteId}/${categoryId}`)) as Array<{ keyword?: unknown }>;
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => asString(entry.keyword))
    .filter((k): k is string => k !== null)
    .slice(0, limit);
}

/**
 * Busca no catálogo. Diferente do search morto, aqui a palavra-chave é
 * OBRIGATÓRIA — não existe filtro por categoria — e o retorno não traz preço.
 */
async function searchCatalog(keyword: string, limit: number): Promise<CatalogProduct[]> {
  const params = new URLSearchParams({
    site_id: settings.search.siteId,
    status: "active",
    q: keyword,
    limit: String(limit),
  });

  const payload = (await fetchJson(`/products/search?${params.toString()}`)) as {
    results?: Array<{ id?: unknown; name?: unknown; pictures?: Array<{ url?: unknown }> }>;
  };

  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .map((r) => {
      const id = asString(r.id);
      if (!id) return null;
      return { id, name: asString(r.name), thumbnail: asString(r.pictures?.[0]?.url) };
    })
    .filter((p): p is CatalogProduct => p !== null);
}

// --- Preço -------------------------------------------------------------------

interface Offer {
  itemId: string;
  price: number;
  originalPrice: number | null;
  freeShipping: boolean;
  sellerId: string | null;
  categoryId: string | null;
}

/**
 * Melhor oferta de um produto do catálogo — a mais barata entre as novas.
 *
 * O ML não expõe mais o vencedor da buy box aqui (`buy_box_winner` vem vazio),
 * então a escolha é nossa. O menor preço é o que o comprador de fato pagaria ao
 * abrir a página, o que mantém a mensagem honesta.
 */
async function bestOffer(productId: string): Promise<Offer | null> {
  const payload = (await fetchJson(`/products/${productId}/items`)) as {
    results?: Array<Record<string, unknown>>;
  };

  const results = Array.isArray(payload.results) ? payload.results : [];
  let best: Offer | null = null;

  for (const raw of results) {
    // Usado/recondicionado vira ruído num grupo de ofertas.
    if (asString(raw.condition) === "used") continue;

    const price = asNumber(raw.price);
    const itemId = asString(raw.item_id);
    if (price === null || !itemId) continue;
    if (best !== null && price >= best.price) continue;

    const originalPrice = asNumber(raw.original_price);
    const shipping = raw.shipping as { free_shipping?: unknown } | null | undefined;

    best = {
      itemId,
      price,
      // Descarta "de/por" incoerente (menor ou igual ao preço atual).
      originalPrice: originalPrice !== null && originalPrice > price ? originalPrice : null,
      freeShipping: shipping?.free_shipping === true,
      sellerId: raw.seller_id != null ? String(raw.seller_id) : null,
      categoryId: asString(raw.category_id),
    };
  }

  return best;
}

/** Título do produto, quando a descoberta veio do highlights (que só dá o id). */
async function fetchProductName(productId: string): Promise<{ name: string | null; thumbnail: string | null }> {
  const payload = (await fetchJson(`/products/${productId}`)) as {
    name?: unknown;
    pictures?: Array<{ url?: unknown }>;
  };
  return { name: asString(payload.name), thumbnail: asString(payload.pictures?.[0]?.url) };
}

/**
 * O `permalink` do /products/{id} vem string vazia na prática, então o link é
 * montado. Esta URL é a página do catálogo e é o que o afiliador recebe.
 */
function productUrl(productId: string): string {
  return `https://www.mercadolivre.com.br/p/${productId}`;
}

// --- Orquestração ------------------------------------------------------------

/** Descobre os candidatos de uma categoria, sem preço ainda, já sem repetidos. */
async function discoverCategory(categoryId: string): Promise<CatalogProduct[]> {
  const { keywordsPerCategory, productsPerKeyword, maxProductsPerCategory } = settings.search;
  const byId = new Map<string, CatalogProduct>();

  const add = (products: CatalogProduct[]) => {
    for (const p of products) {
      // O primeiro a chegar vence, mas um nome/thumb que falte é completado
      // depois — evita uma chamada extra a /products/{id} lá na frente.
      const existing = byId.get(p.id);
      if (!existing) byId.set(p.id, p);
      else if (!existing.name && p.name) byId.set(p.id, { ...existing, name: p.name, thumbnail: p.thumbnail });
    }
  };

  try {
    add(await fetchHighlights(categoryId));
  } catch (err) {
    logger.warn({ category: categoryId, err: (err as Error).message }, "Falha ao buscar mais vendidos");
  }
  await sleep(REQUEST_SPACING_MS);

  if (keywordsPerCategory > 0) {
    let keywords: string[] = [];
    try {
      keywords = await fetchTrendKeywords(categoryId, keywordsPerCategory);
    } catch (err) {
      logger.warn({ category: categoryId, err: (err as Error).message }, "Falha ao buscar termos em alta");
    }
    await sleep(REQUEST_SPACING_MS);

    for (const keyword of keywords) {
      if (byId.size >= maxProductsPerCategory) break;
      try {
        add(await searchCatalog(keyword, productsPerKeyword));
      } catch (err) {
        logger.warn({ category: categoryId, keyword, err: (err as Error).message }, "Falha ao buscar no catálogo");
      }
      await sleep(REQUEST_SPACING_MS);
    }
  }

  return [...byId.values()].slice(0, maxProductsPerCategory);
}

/** Varre as categorias configuradas e devolve os produtos, deduplicados por id. */
export async function searchCategories(): Promise<RawDeal[]> {
  const { categories } = settings.search;
  const byId = new Map<string, RawDeal>();
  let priced = 0;
  let skipped = 0;

  for (const category of categories) {
    const candidates = await discoverCategory(category.id);
    let collected = 0;

    for (const product of candidates) {
      // Produto já visto por outra categoria não precisa de nova chamada.
      if (byId.has(product.id)) continue;

      try {
        const offer = await bestOffer(product.id);
        await sleep(REQUEST_SPACING_MS);

        if (!offer) {
          skipped++;
          continue;
        }
        priced++;

        let { name, thumbnail } = product;
        if (!name) {
          const details = await fetchProductName(product.id);
          name = details.name;
          thumbnail ??= details.thumbnail;
          await sleep(REQUEST_SPACING_MS);
        }
        if (!name) {
          skipped++;
          continue;
        }

        byId.set(product.id, {
          provider: PROVIDER_ID,
          // O id do CATÁLOGO, não o do anúncio: ele é estável mesmo quando o
          // vendedor mais barato muda, o que mantém o histórico de preço e o
          // dedupe apontando sempre para o mesmo produto.
          itemId: product.id,
          title: name,
          price: offer.price,
          originalPrice: offer.originalPrice,
          permalink: productUrl(product.id),
          thumbnail,
          freeShipping: offer.freeShipping,
          sellerId: offer.sellerId,
          // O nome do vendedor exigiria uma chamada a /users/{id} por produto;
          // não compensa, e a mensagem não depende dele.
          sellerName: null,
          categoryId: offer.categoryId ?? category.id,
        });
        collected++;
      } catch (err) {
        // Um produto com problema não pode cancelar os outros.
        skipped++;
        logger.debug({ product: product.id, err: (err as Error).message }, "Falha ao precificar produto");
      }
    }

    logger.debug({ category: category.name, candidates: candidates.length, collected }, "Categoria varrida");
  }

  logger.info(
    { total: byId.size, categories: categories.length, priced, skipped },
    "Busca no Mercado Livre concluída",
  );
  return [...byId.values()];
}
