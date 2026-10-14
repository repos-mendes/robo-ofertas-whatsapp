/**
 * Inspeção rápida da planilha: lista as linhas como o robô as vê e diz quais
 * estão pendentes de envio.
 *
 *   npm run sheet:rows
 */
import { lastPost } from "../src/db.js";
import { fetchSheetRows } from "../src/sheet/client.js";

const rows = await fetchSheetRows();

if (rows.length === 0) {
  console.log("\nA planilha não tem nenhuma linha com link preenchido.\n");
  process.exit(0);
}

console.log(`\n${rows.length} linha(s) com link:\n`);
for (const row of rows) {
  const posted = lastPost("planilha", row.link);
  const state =
    row.status.trim() !== ""
      ? `status "${row.status.trim()}"`
      : posted
        ? `já no banco (enviada em ${new Date(posted.postedAt).toLocaleString("pt-BR")})`
        : "PENDENTE — será enviada no próximo ciclo";

  console.log(`  linha ${row.row}: ${row.link}`);
  console.log(`    preço: ${row.preco || "—"} | de: ${row.precoDe || "—"} | comentário: ${row.comentario || "—"}`);
  console.log(`    ${state}\n`);
}
