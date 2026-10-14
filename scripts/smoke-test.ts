/**
 * Testa o núcleo de decisão — scoring, dedupe e formatação — com dados
 * sintéticos, sem depender de credenciais do Mercado Livre nem do WhatsApp.
 *
 *   npm test
 *
 * Roda contra um banco temporário e o apaga no fim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Precisa vir ANTES de importar qualquer módulo que leia a config: as variáveis
// são lidas no momento do import, e o dotenv não sobrescreve o que já existe.
const tempDir = mkdtempSync(join(tmpdir(), "robo-ofertas-test-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.SHEET_WEBAPP_URL ||= "https://localhost/exec";
process.env.SHEET_WEBAPP_TOKEN ||= "token-de-teste";
process.env.LOG_LEVEL = "silent";
process.env.DRY_RUN = "true";
process.env.HTTP_TOKEN = "token-de-teste";

const { db, markPosted, recordPrice } = await import("../src/db.js");
const { scoreDeals } = await import("../src/pipeline/scoring.js");
const { selectForPosting } = await import("../src/pipeline/dedupe.js");
const { renderDeal, renderOffer, parsePrecoBR } = await import("../src/message/template.js");
const { extractOgTag, preferJpg, extractFeaturedPrice } = await import("../src/scrape/product.js");
const { settings } = await import("../src/config.js");
const { normalize } = await import("../src/pipeline/normalize.js");
type RawDeal = import("../src/providers/types.js").RawDeal;

const DAY = 24 * 60 * 60 * 1000;

function makeDeal(overrides: Partial<RawDeal> & { itemId: string; price: number }): RawDeal {
  return {
    provider: "mercadolivre",
    title: "Produto de teste",
    originalPrice: null,
    permalink: `https://produto.mercadolivre.com.br/${overrides.itemId}`,
    thumbnail: null,
    freeShipping: true,
    sellerId: "seller-1",
    sellerName: "Loja Teste",
    categoryId: "MLB1051",
    ...overrides,
  };
}

/** Insere histórico com datas retroativas (recordPrice sempre grava "agora"). */
function seedHistory(itemId: string, prices: number[], startDaysAgo = 20): void {
  const stmt = db.prepare("INSERT INTO price_history (provider, item_id, price, captured_at) VALUES (?, ?, ?, ?)");
  prices.forEach((price, i) => {
    stmt.run("mercadolivre", itemId, price, Date.now() - (startDaysAgo - i) * DAY);
  });
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

console.log("\n=== Scoring ===\n");

check("aprova queda real contra a mediana do histórico", () => {
  seedHistory("HIST-BOM", [1000, 1000, 1010, 990, 1000, 1000]);
  const deal = makeDeal({ itemId: "HIST-BOM", price: 700 });
  recordPrice("mercadolivre", "HIST-BOM", 700); // como o pipeline faz antes de pontuar

  const { approved } = scoreDeals([deal]);
  assert.equal(approved.length, 1, "deveria aprovar");
  assert.equal(approved[0]!.basis, "history", "deveria usar o histórico como base");
  assert.ok(Math.abs(approved[0]!.discountPct - 30) < 1, `desconto ~30%, veio ${approved[0]!.discountPct}`);
});

check("rejeita item que não está no menor preço da janela", () => {
  seedHistory("HIST-CARO", [1000, 1000, 600, 1000, 1000, 1000]);
  const deal = makeDeal({ itemId: "HIST-CARO", price: 800 });
  recordPrice("mercadolivre", "HIST-CARO", 800);

  const { approved, rejections } = scoreDeals([deal]);
  assert.equal(approved.length, 0, "não deveria aprovar: já esteve a 600");
  assert.equal(rejections["nao_e_o_menor_preco_da_janela"], 1);
});

check("rejeita desconto pequeno mesmo sendo o menor preço", () => {
  seedHistory("HIST-FRACO", [1000, 1000, 1000, 1000, 1000, 1000]);
  const deal = makeDeal({ itemId: "HIST-FRACO", price: 950 });
  recordPrice("mercadolivre", "HIST-FRACO", 950);

  const { approved, rejections } = scoreDeals([deal]);
  assert.equal(approved.length, 0, "5% está abaixo do limiar de 15%");
  assert.equal(rejections["desconto_insuficiente_vs_historico"], 1);
});

check("mediana ignora outlier que destruiria a média", () => {
  // Um único dia a 5000 deslocaria a média para ~1570 e faria 1000 parecer
  // desconto de 36%. Com mediana (1000), não há desconto nenhum.
  seedHistory("HIST-OUTLIER", [1000, 1000, 1000, 1000, 1000, 5000]);
  const deal = makeDeal({ itemId: "HIST-OUTLIER", price: 1000 });
  recordPrice("mercadolivre", "HIST-OUTLIER", 1000);

  const { approved } = scoreDeals([deal]);
  assert.equal(approved.length, 0, "outlier não pode virar oferta");
});

check("sem histórico, aceita desconto grande declarado pelo vendedor", () => {
  const deal = makeDeal({ itemId: "NOVO-BOM", price: 600, originalPrice: 1000 });
  recordPrice("mercadolivre", "NOVO-BOM", 600);

  const { approved } = scoreDeals([deal]);
  assert.equal(approved.length, 1);
  assert.equal(approved[0]!.basis, "original_price");
});

check("sem histórico, rejeita desconto declarado pequeno", () => {
  const deal = makeDeal({ itemId: "NOVO-FRACO", price: 900, originalPrice: 1000 });
  recordPrice("mercadolivre", "NOVO-FRACO", 900);

  const { approved, rejections } = scoreDeals([deal]);
  assert.equal(approved.length, 0, "10% está abaixo do limiar de bootstrap (30%)");
  assert.equal(rejections["desconto_insuficiente_vs_preco_de"], 1);
});

check("respeita a faixa de preço configurada", () => {
  const barato = makeDeal({ itemId: "BARATO", price: 10, originalPrice: 100 });
  const caro = makeDeal({ itemId: "CARO", price: 99999, originalPrice: 200000 });

  const { approved, rejections } = scoreDeals([barato, caro]);
  assert.equal(approved.length, 0);
  assert.equal(rejections["fora_da_faixa_de_preco"], 2);
});

check("prioriza oferta verificada sobre desconto declarado maior", () => {
  seedHistory("PRIO-HIST", [1000, 1000, 1000, 1000, 1000, 1000]);
  const verificada = makeDeal({ itemId: "PRIO-HIST", price: 800, sellerId: "s-a" });
  recordPrice("mercadolivre", "PRIO-HIST", 800);
  const declarada = makeDeal({ itemId: "PRIO-DECL", price: 500, originalPrice: 1000, sellerId: "s-b" });
  recordPrice("mercadolivre", "PRIO-DECL", 500);

  const { approved } = scoreDeals([declarada, verificada]);
  assert.equal(approved.length, 2);
  assert.equal(approved[0]!.itemId, "PRIO-HIST", "a verificada (20%) vem antes da declarada (50%)");
});

console.log("\n=== Dedupe ===\n");

check("bloqueia repost dentro do cooldown", () => {
  seedHistory("REPOST", [1000, 1000, 1000, 1000, 1000, 1000]);
  const deal = makeDeal({ itemId: "REPOST", price: 700 });
  recordPrice("mercadolivre", "REPOST", 700);
  markPosted("mercadolivre", "REPOST", 720);

  const { approved } = scoreDeals([deal]);
  const { selected, rejections } = selectForPosting(approved);
  assert.equal(selected.length, 0, "publicado há pouco, queda de apenas 2.8%");
  assert.equal(rejections["ja_publicado_recentemente"], 1);
});

check("permite repost quando o preço despenca de novo", () => {
  seedHistory("REPOST2", [1000, 1000, 1000, 1000, 1000, 1000]);
  const deal = makeDeal({ itemId: "REPOST2", price: 500 });
  recordPrice("mercadolivre", "REPOST2", 500);
  markPosted("mercadolivre", "REPOST2", 700); // queda de ~29% desde o último post

  const { approved } = scoreDeals([deal]);
  const { selected } = selectForPosting(approved);
  assert.equal(selected.length, 1, "queda acima do limiar de repost deve liberar");
});

check("limita quantas ofertas do mesmo vendedor saem por ciclo", () => {
  const deals = [1, 2, 3, 4].map((n) =>
    makeDeal({ itemId: `SELLER-${n}`, price: 500 + n, originalPrice: 1000, sellerId: "mesmo-vendedor" }),
  );
  for (const d of deals) recordPrice("mercadolivre", d.itemId, d.price);

  const { approved } = scoreDeals(deals);
  assert.equal(approved.length, 4, "as quatro são ofertas válidas");

  const { selected, rejections } = selectForPosting(approved);
  // O teto por vendedor disputa com o teto por ciclo; vale o mais apertado.
  const cap = Math.min(settings.dedupe.maxPostsPerSellerPerRun, settings.dedupe.maxPostsPerRun);
  assert.equal(selected.length, cap);
  assert.ok(Object.keys(rejections).length > 0, "as demais precisam ser rejeitadas por algum teto");
});

console.log("\n=== Formatação ===\n");

check("normaliza título gritado em caixa alta", () => {
  const [deal] = normalize([makeDeal({ itemId: "T", price: 100, title: "FONE  BLUETOOTH   SEM   FIO XPTO" })]);
  assert.equal(deal!.title, "Fone Bluetooth Sem Fio Xpto");
});

check("preserva siglas e modelos ao normalizar", () => {
  const [deal] = normalize([
    makeDeal({ itemId: "T2", price: 100, title: "NOTEBOOK GAMER 16GB RAM SSD 512GB PLACA RTX4060" }),
  ]);
  assert.equal(deal!.title, "Notebook Gamer 16GB RAM SSD 512GB Placa RTX4060");
});

check("mensagem traz preço, desconto e procedência", () => {
  const text = renderDeal(
    {
      ...makeDeal({ itemId: "MSG", price: 700, title: "Fone Bluetooth" }),
      discountPct: 30,
      basis: "history",
      referencePrice: 1000,
      url: "https://mercadolivre.com/sec/ABC123",
    },
    "Mercado Livre",
  );

  // pt-BR formata moeda com espaço NÃO-QUEBRÁVEL depois do "R$". É correto e o
  // WhatsApp renderiza bem; a normalização aqui é só para a asserção.
  const plain = text.replace(/ /g, " ");

  assert.ok(plain.includes("R$ 700,00"), "preço atual");
  assert.ok(plain.includes("R$ 1.000,00"), "preço de referência");
  assert.ok(plain.includes("-30%"), "percentual");
  assert.ok(plain.includes("verificado por nós"), "procedência do desconto");
  assert.ok(plain.includes("https://mercadolivre.com/sec/ABC123"), "link");
});

check("mensagem marca desconto não verificado como declarado pelo vendedor", () => {
  const text = renderDeal(
    {
      ...makeDeal({ itemId: "MSG2", price: 700 }),
      discountPct: 30,
      basis: "original_price",
      referencePrice: 1000,
      url: "https://x",
    },
    "Mercado Livre",
  );
  assert.ok(text.includes("informado pelo vendedor"));
});

console.log("\n=== Fluxo curado (planilha) ===\n");

check("parseia preço em formato brasileiro", () => {
  assert.equal(parsePrecoBR("189,90"), 189.9);
  assert.equal(parsePrecoBR("R$ 1.234,56"), 1234.56);
  assert.equal(parsePrecoBR("1234.56"), 1234.56, "célula numérica vem com ponto decimal");
  assert.equal(parsePrecoBR(""), null);
  assert.equal(parsePrecoBR("promoção"), null);
  assert.equal(parsePrecoBR("0"), null, "preço zero não é preço");
});

check("mensagem curada completa traz de/por, desconto e comentário", () => {
  const text = renderOffer({
    title: "Kit Furadeira 21v",
    link: "https://meli.la/abc",
    preco: "189,90",
    precoDe: "299,90",
    comentario: "Menor preço do ano",
  });
  const plain = text.replace(/ /g, " ");

  assert.ok(plain.includes("*Kit Furadeira 21v*"), "título em negrito");
  assert.ok(plain.includes("~R$ 299,90~"), "preço 'de' riscado");
  assert.ok(plain.includes("R$ 189,90"), "preço atual");
  assert.ok(plain.includes("-37%"), "desconto calculado");
  assert.ok(plain.includes("📌 Menor preço do ano"), "comentário do curador");
  assert.ok(plain.includes("https://meli.la/abc"), "link");
});

check("mensagem curada mínima funciona só com título e link", () => {
  const text = renderOffer({
    title: "Produto Simples",
    link: "https://meli.la/xyz",
    preco: "",
    precoDe: "",
    comentario: "",
  });

  assert.ok(text.includes("*Produto Simples*"));
  assert.ok(text.includes("https://meli.la/xyz"));
  assert.ok(!text.includes("R$"), "sem preço inventado");
  assert.ok(!text.includes("📌"), "sem comentário vazio");
});

check("preço não numérico é publicado como o curador escreveu", () => {
  const text = renderOffer({
    title: "Produto",
    link: "https://meli.la/xyz",
    preco: "a partir de 99 reais",
    precoDe: "",
    comentario: "",
  });
  assert.ok(text.includes("a partir de 99 reais"));
});

check("extrai og:title e og:image com atributos em qualquer ordem", () => {
  const html = `
    <meta property="og:title" content="Furadeira &amp; Parafusadeira"/>
    <meta content="https://http2.mlstatic.com/foto.webp" property="og:image"/>
  `;
  assert.equal(extractOgTag(html, "og:title"), "Furadeira & Parafusadeira", "decodifica entidades");
  assert.equal(extractOgTag(html, "og:image"), "https://http2.mlstatic.com/foto.webp", "ordem invertida");
  assert.equal(extractOgTag(html, "og:description"), null, "tag ausente é null");
});

// HTML sintético no formato real: título em meta no <head>, card do produto
// destacado, e um card de recomendação com OUTRO preço logo depois.
const paginaComPreco = `
  <head><meta name="title" content="Produto Destaque Teste"/></head>
  <body>{"components":[{"type":"title","id":"title","title":{"text":"Produto Destaque Teste"}},{"type":"price","id":"price","price":{"previous_price":{"value":196.07,"currency":"BRL"},"current_price":{"value":169.9,"currency":"BRL"},"installments":{"text":"5x {price} sem juros","values":[{"key":"price","type":"price","price":{"value":33.98,"currency":"BRL"}}]}}},{"type":"shipping","id":"shipping","shipping":{"text":"Frete grátis"}}]}
  {"title":"Produto Recomendado","price":{"previous_price":{"value":999,"currency":"BRL"},"current_price":{"value":888,"currency":"BRL"}}}</body>`;

check("extrai o preço do produto destacado, não da recomendação", () => {
  const price = extractFeaturedPrice(paginaComPreco, "Produto Destaque Teste");
  assert.ok(price, "deveria achar o preço");
  assert.equal(price.current, 169.9);
  assert.equal(price.previous, 196.07);
  assert.equal(price.freeShipping, true);
  assert.ok(price.installments!.includes("5x"), "parcelamento montado");
  assert.ok(price.installments!.includes("33,98"), "valor da parcela em reais");
});

check("sem o título no corpo da página, não inventa preço", () => {
  assert.equal(extractFeaturedPrice(paginaComPreco, "Título Que Não Existe"), null);
  const soHead = `<head><meta name="title" content="Só No Head"/></head><body>{"current_price":{"value":10}}</body>`;
  assert.equal(extractFeaturedPrice(soHead, "Só No Head"), null, "título só em meta do head não é card");
});

check("parcelamento com placeholder não resolvido é descartado", () => {
  const html = `<head></head><body>{"title":{"text":"Com Placeholder"},"price":{"current_price":{"value":100,"currency":"BRL"},"installments":{"text":"{o} {price_total} {en} 6x {price} sem juros","values":[{"key":"price","type":"price","price":{"value":33.98,"currency":"BRL"}}]}}}</body>`;
  const price = extractFeaturedPrice(html, "Com Placeholder");
  assert.ok(price, "o preço em si continua valendo");
  assert.equal(price.current, 100);
  assert.equal(price.installments, null, "linha de parcela some em vez de sair quebrada");
});

check("produto sem 'de' riscado ainda rende o preço atual", () => {
  const html = `<head></head><body>{"title":"Sem Desconto","price":{"current_price":{"value":50.5,"currency":"BRL"}}}</body>`;
  const price = extractFeaturedPrice(html, "Sem Desconto");
  assert.ok(price);
  assert.equal(price.current, 50.5);
  assert.equal(price.previous, null);
});

check("mensagem curada inclui parcelamento e frete grátis quando informados", () => {
  const text = renderOffer({
    title: "Produto",
    link: "https://meli.la/x",
    preco: "169,90",
    precoDe: "",
    comentario: "",
    freteGratis: true,
    parcelamento: "5x R$ 33,98 sem juros",
  });
  assert.ok(text.includes("💳 5x R$ 33,98 sem juros"));
  assert.ok(text.includes("🚚 Frete grátis"));
});

check("prefere a variante JPEG da foto do mlstatic", () => {
  assert.equal(preferJpg("https://http2.mlstatic.com/foto-O.webp"), "https://http2.mlstatic.com/foto-O.jpg");
  assert.equal(preferJpg("https://http2.mlstatic.com/foto-O.jpg"), "https://http2.mlstatic.com/foto-O.jpg");
});

console.log("\n=== Camada HTTP ===\n");

// `inject` executa o ciclo de request do Fastify sem abrir porta de rede.
const { buildServer } = await import("../src/server.js");

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const app = buildServer();

await checkAsync("recusa requisição sem token", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 401);
});

await checkAsync("recusa token errado", async () => {
  const res = await app.inject({ method: "GET", url: "/health", headers: { "x-api-token": "errado" } });
  assert.equal(res.statusCode, 401);
});

await checkAsync("/health responde com o estado dos componentes", async () => {
  const res = await app.inject({ method: "GET", url: "/health", headers: { "x-api-token": process.env.HTTP_TOKEN! } });
  assert.equal(res.statusCode, 200);

  const body = res.json() as {
    ok: boolean;
    dryRun: boolean;
    sheet: { configured: boolean };
    channels: Array<{ id: string }>;
  };

  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.sheet.configured, true, "URL e token da planilha vêm do topo deste arquivo");
  assert.ok(body.channels.some((c) => c.id === "whatsapp"));
});

await app.close();

// --- Encerramento ------------------------------------------------------------

db.close();
rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${passed} verificações passaram${process.exitCode ? " (com falhas acima)" : ""}.\n`);
