/**
 * Converte a URL pública de um produto na versão que gera comissão.
 *
 * Cada loja terá a sua implementação, e nenhuma delas pode ser obrigatória:
 * `convert` deve devolver a URL original em vez de lançar erro quando a
 * afiliação falhar. Perder a comissão de um item é aceitável; deixar de
 * publicar por causa disso, não.
 */
export interface AffiliateConverter {
  readonly id: string;
  convert(url: string): Promise<string>;
  /** Para o endpoint /health. */
  status(): Promise<{ ready: boolean; detail: string }>;
  close?(): Promise<void>;
}
