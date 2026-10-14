/** Um destino de publicação. WhatsApp hoje; Telegram/Discord depois, sem mexer no pipeline. */
export interface Channel {
  readonly id: string;
  /**
   * Publica as ofertas na ordem recebida, respeitando o próprio ritmo de envio.
   * O dryRun vem SEMPRE do pipeline, nunca do .env direto: POST /run pode
   * sobrescrever o padrão por execução, e canal e marcação precisam enxergar
   * o mesmo valor — divergência aqui já marcou oferta como enviada sem enviar.
   */
  publish(offers: readonly OutgoingOffer[], options: { dryRun: boolean }): Promise<PublishResult>;
  status(): Promise<{ ready: boolean; detail: string }>;
  close?(): Promise<void>;
}

/** Oferta pronta para sair: legenda montada e foto já baixada. */
export interface OutgoingOffer {
  /** Linha na planilha — é o identificador que volta em sentRows. */
  row: number;
  /** Link de afiliado; também é a chave de deduplicação no banco. */
  link: string;
  /** Título do produto, para logs. */
  title: string;
  /** Mensagem completa (vira legenda quando há imagem). */
  caption: string;
  /** Foto em JPEG/PNG. Nula = envia só texto, com prévia de link do WhatsApp. */
  image: Buffer | null;
}

export interface PublishResult {
  sent: number;
  failed: number;
  /** Linhas efetivamente publicadas — o pipeline marca status só destas. */
  sentRows: number[];
}
