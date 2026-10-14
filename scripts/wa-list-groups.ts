/**
 * Lista os grupos de que o robô participa, com o JID de cada um.
 *
 *   npm run wa:groups
 *
 * Copie o JID do grupo alvo para WA_GROUP_JID no .env.
 * O número do robô já precisa ser membro do grupo.
 */
import { createWhatsAppClient } from "../src/channels/whatsapp.js";

async function main(): Promise<void> {
  const client = createWhatsAppClient({ printQr: true });
  await client.connect();

  const groups = await client.listGroups();

  if (groups.length === 0) {
    console.log("\nO robô não participa de nenhum grupo ainda.");
    console.log("Adicione o número ao grupo e rode de novo.\n");
  } else {
    console.log(`\n${groups.length} grupo(s):\n`);
    for (const g of groups.sort((a, b) => b.size - a.size)) {
      console.log(`  ${g.subject}  (${g.size} membros)`);
      console.log(`    WA_GROUP_JID=${g.jid}\n`);
    }
    console.log("Copie a linha WA_GROUP_JID do grupo desejado para o seu .env.\n");
  }

  await client.close();
  process.exit(0);
}

void main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
