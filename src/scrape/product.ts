import { logger } from "../logger.js";

/**
 * Extrai título e foto de um link de afiliado (meli.la, mercadolivre.com/sec).
 *
 * O link curto redireciona para a página "Perfil Social" do afiliado com o
 * produto em destaque. Nessa página, `og:title` e `og:image` são DO PRODUTO,
 * mas `<title>` e `og:description` são do perfil do afiliado —
 * por isso este módulo só confia nas tags og: e ignora o resto.
 *
 * Caminho normal: fetch com User-Agent de navegador (validado, o ML não
 * bloqueia). Se um dia bloquear, o fallback abre a página no Chromium do
 * Playwright, que já é dependência do projeto.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;

export interface ScrapedPrice {
  /** Preço atual no momento do scraping. */
  current: number;
  /** Preço "de" riscado que a própria página mostra. */
  previous: number | null;
  /** Texto pronto de parcelamento, ex.: "5x R$ 33,98 sem juros". */
  installments: string | null;
  freeShipping: boolean;
}

export interface ScrapedProduct {
  title: string;
  /** URL da imagem já preferindo a variante JPEG. Nula se a página não tiver og:image. */
  imageUrl: string | null;
  /** Bytes da imagem prontos para o WhatsApp. Nulo se o download falhar. */
  image: Buffer | null;
  /** Preço lido da página no momento do envio. Nulo se a extração não for confiável. */
  price: ScrapedPrice | null;
}

/** Entidades comuns em títulos de produto. Suficiente para og:title; não é um decoder geral de HTML. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Lê uma meta tag og: aceitando os atributos em qualquer ordem. */
export function extractOgTag(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`,
    "i",
  );
  const match = html.match(re);
  const value = match ? (match[1] ?? match[2]) : null;
  return value ? decodeEntities(value.trim()) : null;
}

/**
 * O mlstatic serve a mesma foto trocando só a extensão, e o WhatsApp aceita
 * JPEG mas não WebP em mensagem de imagem (WebP é figurinha).
 */
export function preferJpg(url: string): string {
  return url.replace(/\.webp(\?|$)/i, ".jpg$1");
}

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

/**
 * Extrai o preço do produto EM DESTAQUE do JSON embutido na página.
 *
 * A página do "Perfil Social" traz vários cards com a mesma estrutura de
 * preço: o produto destacado primeiro e uma lista de recomendações depois.
 * Pegar "o primeiro preço da página" às cegas publicaria o preço de outro
 * produto no dia em que o layout mudar — por isso a busca é ancorada no
 * componente de título do card no estado embutido — `"title":{"text":"<título>"`
 * no layout atual (com `"title":"<título>"` aceito como variante) — formato
 * que não ocorre nem nas meta tags nem no HTML renderizado. A janela é curta,
 * menor que a distância até o card seguinte (~5700 chars no layout atual).
 * Título fora do lugar ou janela sem preço ⇒ null, e a mensagem sai sem
 * preço — errado nunca.
 */
export function extractFeaturedPrice(html: string, title: string): ScrapedPrice | null {
  let anchor = html.indexOf(`"title":{"text":"${title}"`);
  if (anchor === -1) anchor = html.indexOf(`"title":"${title}"`);
  if (anchor === -1) return null;

  const card = html.slice(anchor, anchor + 3000);

  const current = card.match(/"current_price":\{"value":([\d.]+)/);
  if (!current) return null;

  const previous = card.match(/"previous_price":\{"value":([\d.]+)/);

  // "installments":{"text":"5x {price} sem juros",...{"key":"price",..."value":33.98
  // O texto é um template com placeholders variados ({price}, {price_total},
  // {o}, {en}...). Só o {price} é resolvido — o valor vem da entrada de chave
  // "price", não da primeira que aparecer. Sobrou placeholder ⇒ linha
  // descartada: parcela errada no grupo é pior que nenhuma.
  const instText = card.match(/"installments":\{"text":"([^"]*)"/);
  const instValue = card.match(/"key":"price","type":"price","price":\{"value":([\d.]+)/);
  let installmentsText: string | null = null;
  if (instText) {
    const rendered = instValue ? instText[1]!.replace("{price}", brl(Number(instValue[1]))) : instText[1]!;
    installmentsText = /[{}]/.test(rendered) ? null : rendered;
  }

  return {
    current: Number(current[1]),
    previous: previous ? Number(previous[1]) : null,
    installments: installmentsText,
    freeShipping: /"shipping":\{"text":"Frete gr[aá]tis"/i.test(card),
  };
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: accept,
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
  });
}

interface PageScrape {
  title: string | null;
  image: string | null;
  /** HTML completo, para a extração de preço. */
  html: string;
}

async function scrapeViaFetch(link: string): Promise<PageScrape> {
  const res = await fetchWithTimeout(link, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  if (!res.ok) throw new Error(`página respondeu ${res.status}`);
  const html = await res.text();
  return { title: extractOgTag(html, "og:title"), image: extractOgTag(html, "og:image"), html };
}

/** Plano B: página real no Chromium. Só roda se o fetch simples não achar og:title. */
async function scrapeViaBrowser(link: string): Promise<PageScrape> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: BROWSER_UA, locale: "pt-BR" });
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: FETCH_TIMEOUT_MS });
    const title = await page.getAttribute('meta[property="og:title"]', "content");
    const image = await page.getAttribute('meta[property="og:image"]', "content");
    return { title: title?.trim() || null, image: image?.trim() || null, html: await page.content() };
  } finally {
    await browser.close();
  }
}

/** Baixa a foto tentando primeiro a variante JPEG. Falha vira null, nunca exceção. */
async function downloadImage(imageUrl: string): Promise<Buffer | null> {
  for (const candidate of [preferJpg(imageUrl), imageUrl]) {
    try {
      const res = await fetchWithTimeout(candidate, "image/jpeg,image/png,image/*;q=0.8");
      const type = res.headers.get("content-type") ?? "";
      // WebP só serve se não houver JPEG; o WhatsApp o trataria como figurinha.
      if (!res.ok || !type.startsWith("image/") || type.includes("webp")) continue;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      continue;
    }
  }
  return null;
}

export async function scrapeProduct(link: string): Promise<ScrapedProduct> {
  let page: PageScrape;

  try {
    page = await scrapeViaFetch(link);
  } catch (err) {
    logger.warn({ link, err: (err as Error).message }, "Fetch simples falhou; tentando via Chromium");
    page = { title: null, image: null, html: "" };
  }

  if (!page.title) {
    try {
      page = await scrapeViaBrowser(link);
    } catch (err) {
      throw new Error(
        `Não foi possível extrair o produto de ${link}: ${(err as Error).message}. ` +
          "Se o erro citar navegador ausente, rode `npm run playwright:install`.",
      );
    }
  }

  if (!page.title) throw new Error(`A página de ${link} não expõe og:title — link errado ou fora do ar?`);

  const image = page.image ? await downloadImage(page.image) : null;
  if (page.image && !image) {
    logger.warn({ link, image: page.image }, "Foto do produto não baixou; a oferta sairá sem imagem");
  }

  const price = extractFeaturedPrice(page.html, page.title);
  if (!price) {
    logger.warn({ link }, "Preço não encontrado na página; a mensagem usará o preço da planilha, se houver");
  }

  return { title: page.title, imageUrl: page.image ? preferJpg(page.image) : null, image, price };
}
