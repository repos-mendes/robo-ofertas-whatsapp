/**
 * Contrato que toda loja precisa cumprir. Adicionar Shopee/AliExpress/Amazon
 * depois significa criar uma pasta nova em providers/ que exporte um
 * DealProvider — nada no pipeline muda.
 */
export interface DealProvider {
  /** Identificador curto e estável; vira chave no banco. Ex.: "mercadolivre". */
  readonly id: string;
  /** Nome exibível, usado em logs e na mensagem. */
  readonly label: string;
  fetchDeals(): Promise<RawDeal[]>;
}

/** Produto como veio da loja, ainda sem julgamento sobre ser ou não oferta. */
export interface RawDeal {
  provider: string;
  itemId: string;
  title: string;
  price: number;
  /** Preço "de" informado pela loja. Frequentemente inflado — nunca confie sozinho. */
  originalPrice: number | null;
  permalink: string;
  thumbnail: string | null;
  freeShipping: boolean;
  sellerId: string | null;
  sellerName: string | null;
  categoryId: string | null;
}

/** Como o desconto foi calculado — muda a confiança na oferta. */
export type DiscountBasis =
  /** Comparado com o histórico de preço coletado por nós. Confiável. */
  | "history"
  /** Comparado com o original_price da loja. Só usado enquanto falta histórico. */
  | "original_price";

/** Produto já avaliado e aprovado para publicação. */
export interface Deal extends RawDeal {
  discountPct: number;
  basis: DiscountBasis;
  /** Preço de referência contra o qual o desconto foi medido. */
  referencePrice: number;
  /** Preenchido no estágio de afiliação; cai para o permalink se falhar. */
  url: string;
}
