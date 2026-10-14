/**
 * Teste de aceite da Fase 1: prova que o OAuth e a busca funcionam,
 * sem tocar em scoring, afiliação ou WhatsApp.
 *
 *   npm run ml:search
 */
import { searchCategories } from "../src/providers/mercadolivre/search.js";

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main(): Promise<void> {
  const deals = await searchCategories();

  if (deals.length === 0) {
    console.error("\nNenhum produto retornado. Verifique as categorias em config.json.\n");
    process.exitCode = 1;
    return;
  }

  const withOriginal = deals.filter((d) => d.originalPrice !== null);

  const top = [...withOriginal]
    .sort((a, b) => (b.originalPrice! - b.price) / b.originalPrice! - (a.originalPrice! - a.price) / a.originalPrice!)
    .slice(0, 20);

  console.log(`\n${deals.length} produtos coletados; ${withOriginal.length} com preço "de/por".\n`);
  console.log('Top 20 por desconto declarado (ainda NÃO validado contra histórico):\n');

  for (const d of top) {
    const pct = Math.round(((d.originalPrice! - d.price) / d.originalPrice!) * 100);
    console.log(`  -${String(pct).padStart(2)}%  ${brl(d.price).padStart(12)}  (de ${brl(d.originalPrice!)})`);
    console.log(`        ${d.title.slice(0, 80)}`);
    console.log(`        ${d.permalink}\n`);
  }

  console.log("Lembrete: original_price é informado pelo vendedor e costuma ser inflado.");
  console.log("O filtro real usa o histórico de preço coletado por nós (Fase 2).\n");
}

void main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exitCode = 1;
});
