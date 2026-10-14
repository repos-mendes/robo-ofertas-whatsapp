/**
 * Autorização única da aplicação no Mercado Livre.
 *
 * O ML só aceita os grant types `authorization_code` e `refresh_token` — não
 * existe `client_credentials`. Ou seja: há um login humano obrigatório, uma
 * vez. Depois disso o robô se vira sozinho com o refresh token.
 *
 * Em vez de subir um servidor HTTPS só para receber o callback, este script
 * pede que você cole de volta o `code` que aparece na barra de endereço.
 *
 *   npm run ml:auth
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildAuthUrl, createPkcePair, exchangeCode } from "../src/providers/mercadolivre/auth.js";
import { env } from "../src/config.js";

// PKCE por padrão (o ML recomenda). Se a sua aplicação não estiver configurada
// para isso e a troca falhar, rode com ML_USE_PKCE=false.
const usePkce = process.env.ML_USE_PKCE?.toLowerCase() !== "false";

async function main(): Promise<void> {
  const pkce = usePkce ? createPkcePair() : null;
  const authUrl = buildAuthUrl(pkce?.challenge);

  console.log("\n=== Autorização do Mercado Livre ===\n");
  console.log("1. Abra esta URL no navegador e faça login:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Você será redirecionado para ${env.ML_REDIRECT_URI}?code=...`);
  console.log("   A página provavelmente vai dar erro de conexão — isso é esperado e não é problema.");
  console.log("   O que importa é a URL na barra de endereço.\n");
  console.log("3. Copie o valor do parâmetro `code` (ou cole a URL inteira) abaixo.\n");
  if (pkce) console.log("   (PKCE ativo — não feche este terminal, o code_verifier só existe aqui.)\n");

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("code ou URL completa> ")).trim();
  rl.close();

  if (!answer) {
    console.error("\nNada informado. Abortado.");
    process.exitCode = 1;
    return;
  }

  // Aceita tanto o code puro quanto a URL inteira colada.
  let code = answer;
  if (answer.includes("code=")) {
    const fromUrl = new URL(answer.startsWith("http") ? answer : `https://x/?${answer.split("?").pop()}`).searchParams.get(
      "code",
    );
    if (fromUrl) code = fromUrl;
  }

  try {
    const token = await exchangeCode(code, pkce?.verifier);
    console.log("\n✓ Autorizado. Tokens gravados em data/ofertas.db");
    console.log(`  Access token expira em ${new Date(token.expiresAt).toLocaleString("pt-BR")}`);
    console.log("\n  A partir daqui o robô renova sozinho. Rode `npm run ml:search` para testar.\n");
  } catch (err) {
    console.error(`\n✗ Falhou: ${(err as Error).message}\n`);
    console.error("Causas comuns:");
    console.error("  - o `code` expira em poucos minutos e é de uso único: refaça o passo 1;");
    console.error("  - ML_REDIRECT_URI no .env precisa ser idêntica à cadastrada na aplicação;");
    console.error("  - se o erro citar PKCE/code_verifier, tente: ML_USE_PKCE=false npm run ml:auth\n");
    process.exitCode = 1;
  }
}

void main();
