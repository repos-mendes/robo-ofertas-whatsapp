import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { paths, settings } from "../config.js";
import { readAffiliateLink, writeAffiliateLink } from "../db.js";
import { logger } from "../logger.js";
import type { AffiliateConverter } from "./types.js";

/**
 * ATENÇÃO — este é o arquivo mais frágil do projeto, por construção.
 *
 * O Mercado Livre não expõe API de geração de link de afiliado: a única forma
 * é o painel web. Automatizá-lo é uso não documentado do site e vai quebrar
 * quando o layout mudar. Duas defesas contra isso:
 *
 *  1. O link gerado é extraído por REGEX na página inteira, não por um seletor
 *     de resultado. Um redesenho do painel muda classes CSS, mas dificilmente
 *     muda o formato do link (mercadolivre.com/sec/XXXX).
 *  2. Qualquer falha degrada para o permalink puro em vez de derrubar o ciclo.
 *     Perde-se a comissão de um item; o robô continua publicando.
 */

/**
 * O painel devolve o link em um de dois formatos, conforme a ferramenta usada:
 * o encurtado (`mercadolivre.com/sec/XXXX`) ou a URL do produto com parâmetro
 * de atribuição. Os dois padrões são específicos o bastante para não casarem
 * com links comuns presentes na página.
 */
const AFFILIATE_LINK_PATTERNS = [
  /https?:\/\/(?:www\.)?mercadolivre\.com\/sec\/[A-Za-z0-9]+/,
  /https?:\/\/[^\s"'<>]*mercadolivre\.com\.br\/[^\s"'<>]*[?&](?:affiliate|matt_word|matt_tool)=[^\s"'<>&]+[^\s"'<>]*/,
];

function extractAffiliateLink(text: string): string | null {
  for (const pattern of AFFILIATE_LINK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** Sinais de que a sessão salva expirou e o painel jogou o robô para o login. */
const LOGIN_URL_RE = /\/(login|hub\/registration|signin)/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MlPanelOptions {
  /** Abre o navegador visível. Usado pelo script de login e para calibrar seletores. */
  headed?: boolean;
}

class MlPanelConverter implements AffiliateConverter {
  readonly id = "ml-panel";

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionExpired = false;

  constructor(private readonly options: MlPanelOptions = {}) {}

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!existsSync(paths.mlPanelState)) {
      throw new Error("Sessão do painel de afiliados ausente. Rode `npm run ml:affiliate-login` uma vez.");
    }

    this.browser ??= await chromium.launch({ headless: !this.options.headed });
    this.context ??= await this.browser.newContext({
      storageState: paths.mlPanelState,
      locale: "pt-BR",
      viewport: { width: 1366, height: 900 },
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  /**
   * Preenche o campo de URL do painel. Tenta vários seletores porque o painel
   * não tem contrato estável; o primeiro que estiver visível vence.
   */
  private async fillSourceUrl(page: Page, url: string): Promise<void> {
    const candidates = [
      ...settings.affiliate.selectors.urlInput,
      'input[placeholder*="link" i]',
      'input[placeholder*="url" i]',
      'input[placeholder*="produto" i]',
      "textarea",
      'input[type="text"]',
    ];

    for (const selector of candidates) {
      const field = page.locator(selector).first();
      try {
        await field.waitFor({ state: "visible", timeout: 2500 });
        await field.fill(url);
        return;
      } catch {
        // seletor não existe nesta versão do painel — tenta o próximo
      }
    }
    throw new Error("Campo de URL não encontrado no painel (seletores desatualizados)");
  }

  private async clickGenerate(page: Page): Promise<void> {
    const candidates = settings.affiliate.selectors.generateButton;

    for (const selector of candidates) {
      const button = page.locator(selector).first();
      try {
        await button.waitFor({ state: "visible", timeout: 2500 });
        await button.click();
        return;
      } catch {
        // idem
      }
    }

    // Último recurso: alguns formulários geram ao pressionar Enter.
    await page.keyboard.press("Enter");
  }

  /** Varre a página até um link /sec/ aparecer, em vez de esperar um seletor específico. */
  private async waitForAffiliateLink(page: Page, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const fromHtml = extractAffiliateLink(await page.content());
      if (fromHtml) return fromHtml;

      // O resultado costuma ficar no `value` de um input readonly, que não
      // aparece no HTML serializado — daí a leitura separada dos campos.
      const values = await page.evaluate(() =>
        [...document.querySelectorAll("input, textarea")]
          .map((el) => (el as HTMLInputElement | HTMLTextAreaElement).value ?? "")
          .join("\n"),
      );
      const fromInputs = extractAffiliateLink(values);
      if (fromInputs) return fromInputs;

      await sleep(500);
    }
    return null;
  }

  async convert(url: string): Promise<string> {
    const cached = readAffiliateLink(url);
    if (cached) return cached;

    if (this.sessionExpired) return url;

    try {
      const page = await this.ensurePage();
      await page.goto(settings.affiliate.panelUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      if (LOGIN_URL_RE.test(page.url())) {
        this.sessionExpired = true;
        logger.error("Sessão do painel de afiliados expirou. Rode `npm run ml:affiliate-login` para renovar. Enquanto isso, os links vão sem afiliação.");
        return url;
      }

      await this.fillSourceUrl(page, url);
      await this.clickGenerate(page);

      const link = await this.waitForAffiliateLink(page, settings.affiliate.generateTimeoutMs);
      if (!link) {
        logger.warn({ url }, "Painel não devolveu link de afiliado; publicando link direto");
        return url;
      }

      writeAffiliateLink(url, link);
      logger.debug({ url, link }, "Link de afiliado gerado");
      return link;
    } catch (err) {
      // Nunca propaga: a afiliação é um upgrade, não um requisito.
      logger.warn({ url, err: (err as Error).message }, "Falha ao afiliar; publicando link direto");
      return url;
    }
  }

  async status(): Promise<{ ready: boolean; detail: string }> {
    if (!existsSync(paths.mlPanelState)) {
      return { ready: false, detail: "sessão ausente; rode npm run ml:affiliate-login" };
    }
    if (this.sessionExpired) {
      return { ready: false, detail: "sessão expirada; rode npm run ml:affiliate-login" };
    }
    return { ready: true, detail: "sessão presente" };
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

export function createMlPanelConverter(options?: MlPanelOptions): AffiliateConverter {
  return new MlPanelConverter(options);
}
