import { createWhatsAppChannel } from "./channels/whatsapp.js";
import type { Channel } from "./channels/types.js";

/**
 * Ponto único de montagem do sistema.
 *
 * Desde a virada para o fluxo curado (planilha), só os canais são montados
 * aqui. O código do Mercado Livre (providers/, affiliate/) segue no repositório
 * mas dormente: religá-lo um dia significa citá-lo de novo neste arquivo.
 */

export const channels: Channel[] = [createWhatsAppChannel()];

export async function closeAll(): Promise<void> {
  await Promise.allSettled(channels.map((c) => c.close?.()));
}
