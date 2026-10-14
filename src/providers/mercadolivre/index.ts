import type { DealProvider, RawDeal } from "../types.js";
import { PROVIDER_ID } from "./auth.js";
import { searchCategories } from "./search.js";

export const mercadoLivreProvider: DealProvider = {
  id: PROVIDER_ID,
  label: "Mercado Livre",
  fetchDeals(): Promise<RawDeal[]> {
    return searchCategories();
  },
};

export { PROVIDER_ID, tokenStatus } from "./auth.js";
