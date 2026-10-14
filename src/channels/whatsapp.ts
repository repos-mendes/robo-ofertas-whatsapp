import { mkdirSync } from "node:fs";
import {
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { env, paths, settings } from "../config.js";
import { logger } from "../logger.js";
import type { Channel, OutgoingOffer, PublishResult } from "./types.js";

/**
 * ATENÇÃO — ponto frágil e deliberado do projeto.
 *
 * O Baileys conversa com o WhatsApp Web por engenharia reversa e viola os
 * Termos de Serviço do WhatsApp. O número usado aqui pode ser banido sem
 * aviso: use um chip dedicado, nunca o pessoal. A alternativa oficial (Cloud
 * API) limita grupos a 8 participantes, o que não serve para grupo de ofertas.
 *
 * Todo o contato com a biblioteca está confinado a este arquivo.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * O Baileys embrulha os erros de conexão em objetos Boom. Em vez de depender de
 * @hapi/boom — que só existe aqui como dependência transitiva e pode sumir numa
 * atualização —, lemos apenas o campo de que precisamos.
 */
function disconnectStatusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: unknown } } | undefined)?.output;
  return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

/** Intervalo aleatório entre mensagens. Rajada é o que mais rápido queima um número. */
function humanDelay(): number {
  const { minDelayMs, maxDelayMs } = settings.whatsapp;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

export interface WhatsAppClientOptions {
  /** Exibe o QR no terminal. Só faz sentido em execução interativa. */
  printQr?: boolean;
}

class WhatsAppClient {
  private socket: WASocket | null = null;
  private connected = false;
  private loggedOut = false;
  private connecting: Promise<void> | null = null;
  private reconnectAttempts = 0;
  /** Fila das gravações de credencial em andamento. Ver `creds.update`, abaixo. */
  private credsFlush: Promise<void> = Promise.resolve();

  constructor(private readonly options: WhatsAppClientOptions = {}) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get isLoggedOut(): boolean {
    return this.loggedOut;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    mkdirSync(paths.waSession, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(paths.waSession);

    await new Promise<void>((resolve, reject) => {
      const socket = makeWASocket({
        auth: state,
        // O log do Baileys é extremamente verboso; silenciado aqui e
        // substituído pelos eventos que realmente importam, abaixo.
        logger: logger.child({ mod: "baileys" }, { level: "silent" }),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.socket = socket;

      // `saveCreds` grava com writeFile assíncrono e o emitter do Baileys não
      // aguarda handlers async. Sem enfileirar aqui e esperar em close(), um
      // process.exit() logo depois trunca creds.json — e um creds.json vazio
      // não dá erro: o Baileys o lê como nulo e começa uma sessão nova, então
      // o pareamento se perde em silêncio e o QR volta a aparecer.
      socket.ev.on("creds.update", () => {
        this.credsFlush = this.credsFlush
          .then(() => saveCreds())
          .catch((err: unknown) => {
            logger.error({ err: (err as Error).message }, "Falha ao salvar credenciais do WhatsApp");
          });
      });

      socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && this.options.printQr) {
          console.log("\nEscaneie o QR abaixo no WhatsApp do robô:");
          console.log("(WhatsApp > Dispositivos conectados > Conectar dispositivo)\n");
          qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
          this.connected = true;
          this.loggedOut = false;
          this.reconnectAttempts = 0;
          logger.info("WhatsApp conectado");
          resolve();
          return;
        }

        if (connection === "close") {
          this.connected = false;
          const statusCode = disconnectStatusCode(lastDisconnect?.error);

          // loggedOut é terminal: a sessão salva não vale mais e só um novo QR
          // resolve. Reconectar em loop aqui só geraria ruído infinito.
          if (statusCode === DisconnectReason.loggedOut) {
            this.loggedOut = true;
            logger.error("WhatsApp desconectado definitivamente (logged out). Rode `npm run wa:login` e escaneie o QR de novo.");
            reject(new Error("WhatsApp deslogado: é necessário parear novamente"));
            return;
          }

          logger.warn({ statusCode }, "WhatsApp caiu; tentará reconectar");
          reject(new Error(`Conexão do WhatsApp encerrada (código ${statusCode ?? "desconhecido"})`));
        }
      });
    });
  }

  /** Reconecta com backoff exponencial limitado. */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.loggedOut) throw new Error("WhatsApp deslogado: rode `npm run wa:login`");

    const maxAttempts = 4;
    while (this.reconnectAttempts < maxAttempts) {
      try {
        await this.connect();
        return;
      } catch (err) {
        if (this.loggedOut) throw err;
        this.reconnectAttempts++;
        const wait = Math.min(30_000, 2_000 * 2 ** this.reconnectAttempts);
        logger.warn({ attempt: this.reconnectAttempts, wait }, "Nova tentativa de conexão ao WhatsApp");
        await sleep(wait);
      }
    }
    throw new Error(`Não foi possível conectar ao WhatsApp após ${maxAttempts} tentativas`);
  }

  async sendText(jid: string, text: string): Promise<void> {
    await this.ensureConnected();
    if (!this.socket) throw new Error("Socket do WhatsApp indisponível");
    await this.socket.sendMessage(jid, { text });
  }

  /** Foto com legenda — o formato clássico de grupo de ofertas. JPEG/PNG apenas; WebP vira figurinha. */
  async sendImage(jid: string, image: Buffer, caption: string): Promise<void> {
    await this.ensureConnected();
    if (!this.socket) throw new Error("Socket do WhatsApp indisponível");
    await this.socket.sendMessage(jid, { image, caption });
  }

  async listGroups(): Promise<Array<{ jid: string; subject: string; size: number }>> {
    await this.ensureConnected();
    if (!this.socket) throw new Error("Socket do WhatsApp indisponível");
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      jid: g.id,
      subject: g.subject,
      size: g.participants?.length ?? 0,
    }));
  }

  async close(): Promise<void> {
    this.socket?.end(undefined);
    this.socket = null;
    this.connected = false;
    // Só então é seguro encerrar o processo: as credenciais estão em disco.
    await this.credsFlush;
  }
}

export function createWhatsAppClient(options?: WhatsAppClientOptions): WhatsAppClient {
  return new WhatsAppClient(options);
}

export type { WhatsAppClient };

// --- Canal usado pelo pipeline ----------------------------------------------

export function createWhatsAppChannel(client = createWhatsAppClient()): Channel {
  return {
    id: "whatsapp",

    async publish(offers: readonly OutgoingOffer[], options: { dryRun: boolean }): Promise<PublishResult> {
      let sent = 0;
      let failed = 0;
      const sentRows: number[] = [];

      if (offers.length === 0) return { sent, failed, sentRows };

      if (!env.WA_GROUP_JID) {
        throw new Error("WA_GROUP_JID não configurado no .env. Descubra o JID com `npm run wa:groups`.");
      }

      for (const [index, offer] of offers.entries()) {
        if (options.dryRun) {
          const foto = offer.image ? `com foto (${offer.image.length} bytes)` : "SEM foto";
          console.log(`\n--- [DRY_RUN] mensagem ${index + 1}/${offers.length} · ${foto} ---\n${offer.caption}\n`);
          sent++;
          sentRows.push(offer.row);
        } else {
          try {
            if (offer.image) {
              await client.sendImage(env.WA_GROUP_JID, offer.image, offer.caption);
            } else {
              await client.sendText(env.WA_GROUP_JID, offer.caption);
            }
            sent++;
            sentRows.push(offer.row);
            logger.info({ row: offer.row, title: offer.title }, "Oferta publicada");
          } catch (err) {
            failed++;
            logger.error({ row: offer.row, err: (err as Error).message }, "Falha ao publicar oferta");
          }
        }

        // Espaça as mensagens, exceto depois da última.
        if (index < offers.length - 1 && !options.dryRun) await sleep(humanDelay());
      }

      return { sent, failed, sentRows };
    },

    async status() {
      if (env.DRY_RUN) return { ready: true, detail: "DRY_RUN ativo (nada é enviado)" };
      if (client.isLoggedOut) return { ready: false, detail: "deslogado; rode npm run wa:login" };
      if (!env.WA_GROUP_JID) return { ready: false, detail: "WA_GROUP_JID ausente no .env" };
      return { ready: client.isConnected, detail: client.isConnected ? "conectado" : "desconectado" };
    },

    async close() {
      await client.close();
    },
  };
}
