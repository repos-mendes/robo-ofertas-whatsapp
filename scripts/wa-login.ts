/**
 * Pareamento único do WhatsApp do robô.
 *
 *   npm run wa:login
 *
 * A sessão fica em data/wa-session/ e sobrevive a reinícios — só é preciso
 * repetir se o WhatsApp deslogar o dispositivo.
 *
 * Use um chip DEDICADO. O Baileys viola os Termos de Serviço do WhatsApp e o
 * número pode ser banido.
 */
import { createWhatsAppClient } from "../src/channels/whatsapp.js";

async function main(): Promise<void> {
  const client = createWhatsAppClient({ printQr: true });

  console.log("\n=== Pareamento do WhatsApp ===");
  console.log("Aguardando QR code...\n");

  try {
    await client.connect();
  } finally {
    // Pelo finally, e não depois do connect: o WhatsApp derruba a conexão com
    // o código 515 logo após o pareamento, e as credenciais que acabaram de
    // chegar precisam ir para o disco também nesse caminho — senão o
    // process.exit abaixo as descarta e o QR volta na próxima execução.
    await client.close();
  }

  console.log("\n✓ Conectado e sessão salva em data/wa-session/");
  console.log("  Próximo passo: `npm run wa:groups` para descobrir o JID do grupo.\n");
  process.exit(0);
}

void main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}`);
  console.error("  Se o código for 515, a sessão foi salva: rode `npm run wa:login` outra vez.\n");
  process.exit(1);
});
