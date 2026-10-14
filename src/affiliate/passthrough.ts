import type { AffiliateConverter } from "./types.js";

/**
 * Não afilia nada: devolve a URL como veio. Serve de fallback quando o
 * conversor real está indisponível e como modo de operação enquanto o cadastro
 * de afiliado ainda não existe.
 */
export const passthroughConverter: AffiliateConverter = {
  id: "passthrough",
  async convert(url: string): Promise<string> {
    return url;
  },
  async status() {
    return { ready: true, detail: "sem afiliação (links diretos)" };
  },
};
