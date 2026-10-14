import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));

// Sobe até achar o package.json em vez de assumir "um nível acima": compilado,
// este arquivo vive em dist/src/ (rootDir "." no tsconfig), e "um nível acima"
// seria dist/ — sem .env nem config.json.
function findProjectRoot(start: string): string {
  let dir = start;
  while (!existsSync(resolve(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Não achei o package.json subindo a partir de ${start}`);
    }
    dir = parent;
  }
  return dir;
}

/** Raiz do projeto — usada para resolver config.json, .env e data/. */
export const ROOT = findProjectRoot(here);

loadDotenv({ path: resolve(ROOT, ".env") });

/**
 * Variáveis sensíveis vêm do .env; as regras de negócio vêm do config.json.
 * A separação é proposital: você ajusta limiares e categorias sem tocar em
 * credenciais, e o config.json pode ser versionado com segurança.
 */
const envSchema = z.object({
  // As credenciais do ML ficaram opcionais quando o fluxo passou a ser a
  // planilha curada: os scripts ml:* ainda existem, mas o ciclo não depende
  // mais deles e não deve morrer no boot por causa de uma credencial parada.
  ML_CLIENT_ID: z.string().optional().default(""),
  ML_CLIENT_SECRET: z.string().optional().default(""),
  ML_REDIRECT_URI: z.string().optional().default(""),
  SHEET_WEBAPP_URL: z
    .string()
    .url("SHEET_WEBAPP_URL precisa ser a URL /exec do app da web (Apps Script) da planilha"),
  SHEET_WEBAPP_TOKEN: z.string().min(1, "SHEET_WEBAPP_TOKEN ausente no .env"),
  WA_GROUP_JID: z.string().optional().default(""),
  HTTP_PORT: z.coerce.number().int().positive().default(8787),
  HTTP_TOKEN: z.string().optional().default(""),
  DRY_RUN: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  LOG_LEVEL: z.string().optional().default("info"),
  /** Override do banco. Existe para os testes rodarem sem tocar nos dados reais. */
  DB_PATH: z.string().optional().default(""),
});

const configSchema = z.object({
  schedule: z.string().min(1),
  search: z.object({
    siteId: z.string().min(1),
    categories: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
    // A coleta faz ~1 chamada por produto (ver o cabeçalho de search.ts), então
    // estes tetos são o que separa um ciclo de 2 minutos de um de 40.
    keywordsPerCategory: z.number().int().nonnegative().max(10),
    productsPerKeyword: z.number().int().positive().max(50),
    maxProductsPerCategory: z.number().int().positive().max(500),
  }),
  scoring: z.object({
    minPrice: z.number().nonnegative(),
    maxPrice: z.number().positive(),
    minDiscountPct: z.number().min(0).max(100),
    historyWindowDays: z.number().int().positive(),
    minHistoryPoints: z.number().int().positive(),
    bootstrapMinDiscountPct: z.number().min(0).max(100),
    requireFreeShipping: z.boolean(),
  }),
  dedupe: z.object({
    repostCooldownDays: z.number().int().nonnegative(),
    repostIfPriceDropsPct: z.number().min(0).max(100),
    maxPostsPerRun: z.number().int().positive(),
    maxPostsPerDay: z.number().int().positive(),
    maxPostsPerSellerPerRun: z.number().int().positive(),
  }),
  whatsapp: z.object({
    minDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
  }),
  affiliate: z.object({
    enabled: z.boolean(),
    panelUrl: z.string().url(),
    generateTimeoutMs: z.number().int().positive(),
    selectors: z.object({
      urlInput: z.array(z.string()),
      generateButton: z.array(z.string()),
    }),
  }),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`Configuração inválida no .env:\n${issues}\n\nCopie .env.example para .env e preencha.`);
  }
  return result.data;
}

function parseConfigFile() {
  const path = resolve(ROOT, "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Não foi possível ler ${path}: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`config.json inválido:\n${issues}`);
  }
  if (result.data.whatsapp.maxDelayMs < result.data.whatsapp.minDelayMs) {
    throw new Error("config.json inválido: whatsapp.maxDelayMs não pode ser menor que minDelayMs");
  }
  return result.data;
}

export const env = parseEnv();
export const settings = parseConfigFile();

/** Caminhos de estado. Tudo dentro de data/, que está no .gitignore. */
export const paths = {
  data: resolve(ROOT, "data"),
  db: env.DB_PATH ? resolve(env.DB_PATH) : resolve(ROOT, "data", "ofertas.db"),
  waSession: resolve(ROOT, "data", "wa-session"),
  mlPanelState: resolve(ROOT, "data", "ml-panel.json"),
  logs: resolve(ROOT, "logs"),
} as const;
