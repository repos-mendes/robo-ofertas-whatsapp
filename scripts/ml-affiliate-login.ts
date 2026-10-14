/**
 * Login único no painel de afiliados do Mercado Livre.
 *
 *   npm run ml:affiliate-login
 *
 * Abre um Chromium VISÍVEL para você logar à mão (inclusive 2FA). Ao apertar
 * Enter no terminal, os cookies são salvos em data/ml-panel.json e o robô passa
 * a reutilizá-los em modo headless.
 *
 * Este script também serve para calibrar os seletores de config.json: com o
 * navegador aberto no painel, inspecione o campo de URL e o botão de gerar.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { paths, settings } from "../src/config.js";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "pt-BR", viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  console.log("\n=== Login no painel de afiliados do Mercado Livre ===\n");
  console.log(`Abrindo ${settings.affiliate.panelUrl}`);
  console.log("\n1. Faça login normalmente na janela do navegador (incluindo 2FA).");
  console.log("2. Navegue até o GERADOR DE LINKS e deixe a página aberta nele.");
  console.log("3. Se a URL do gerador for diferente da configurada, copie a URL da barra");
  console.log("   de endereço e atualize `affiliate.panelUrl` no config.json.");
  console.log("4. Volte aqui e aperte Enter.\n");

  await page.goto(settings.affiliate.panelUrl, { waitUntil: "domcontentloaded" }).catch(() => {
    console.log("(A navegação inicial falhou — navegue manualmente no navegador aberto.)");
  });

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question("Aperte Enter quando estiver logado e no gerador de links> ");
  rl.close();

  const finalUrl = page.url();
  await context.storageState({ path: paths.mlPanelState });

  console.log(`\n✓ Sessão salva em ${paths.mlPanelState}`);
  console.log(`  URL onde você parou: ${finalUrl}`);
  if (finalUrl !== settings.affiliate.panelUrl) {
    console.log("\n  ⚠ Essa URL é diferente da que está em config.json.");
    console.log(`     Considere trocar affiliate.panelUrl para:\n     ${finalUrl}`);
  }
  console.log("\n  Esse arquivo é uma credencial: dá acesso à sua conta. Está no .gitignore — mantenha assim.\n");

  await browser.close();
  process.exit(0);
}

void main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
