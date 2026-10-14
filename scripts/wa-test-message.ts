/**
 * Envia UMA mensagem de teste para o WA_GROUP_JID do .env.
 *
 *   npm run wa:test
 *
 * Serve para validar o caminho de envio de ponta a ponta — sessão, JID e
 * formatação — sem depender de um ciclo de coleta ter encontrado oferta.
 *
 * Envia DE VERDADE: este script ignora o DRY_RUN de propósito, porque testar
 * envio com envio desligado não testa nada. Confira o grupo antes de rodar; o
 * script imprime o JID de destino e espera 5s para você poder abortar.
 *
 * A oferta é fictícia e a mensagem vai marcada como teste, para o caso de o
 * comando ser rodado apontando para um grupo de verdade.
 */
import { createWhatsAppClient } from "../src/channels/whatsapp.js";
import { env } from "../src/config.js";
import { renderDeal } from "../src/message/template.js";
import type { Deal } from "../src/providers/types.js";

const exemplo: Deal = {
  provider: "mercadolivre",
  itemId: "MLB0000000000",
  title: "Fone de Ouvido Bluetooth Exemplo XT-900 (produto fictício)",
  price: 149.9,
  originalPrice: 299.9,
  permalink: "https://www.mercadolivre.com.br/p/MLB0000000000",
  thumbnail: null,
  freeShipping: true,
  sellerId: null,
  sellerName: null,
  categoryId: "MLB1051",
  discountPct: 50,
  basis: "history",
  referencePrice: 299.9,
  url: "https://www.mercadolivre.com.br/p/MLB0000000000",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!env.WA_GROUP_JID) {
    throw new Error("WA_GROUP_JID não configurado no .env. Rode `npm run wa:groups`.");
  }

  const texto = `🧪 *MENSAGEM DE TESTE DO ROBÔ* — ignore\n\n${renderDeal(exemplo, "Mercado Livre")}`;

  console.log("\n=== Envio de teste ===");
  console.log(`Destino: ${env.WA_GROUP_JID}`);
  console.log("\nMensagem:\n");
  console.log(texto);
  console.log("\nEnviando em 5s — Ctrl+C para abortar.\n");
  await sleep(5000);

  const client = createWhatsAppClient();
  try {
    await client.sendText(env.WA_GROUP_JID, texto);
    console.log("✓ Mensagem enviada. Confira o grupo.\n");
  } finally {
    await client.close();
  }

  process.exit(0);
}

void main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
