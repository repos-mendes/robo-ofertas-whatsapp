import { z } from "zod";
import { env } from "../config.js";
import { logger } from "../logger.js";

/**
 * Cliente do web app (Apps Script) que expõe a planilha de ofertas curadas.
 *
 * O script implantado na planilha (scripts/planilha-webapp.gs) oferece:
 *   GET  ?token=...              → todas as linhas com link preenchido
 *   POST {token, row, status}    → escreve na coluna Status da linha
 *
 * O Apps Script responde ao POST com um redirect 302 para googleusercontent;
 * o fetch do Node segue o redirect sozinho e o JSON chega no fim. Por isso os
 * dois caminhos usam `redirect: "follow"` explícito — remover isso quebra só
 * o POST, e de um jeito difícil de diagnosticar.
 */

const rowSchema = z.object({
  /** Número real da linha na planilha (a 1 é o cabeçalho). Usado no POST. */
  row: z.number().int().min(2),
  link: z.string().min(1),
  preco: z.string(),
  precoDe: z.string(),
  comentario: z.string(),
  status: z.string(),
});

const listSchema = z.object({ ok: z.literal(true), rows: z.array(rowSchema) });
const ackSchema = z.object({ ok: z.literal(true) });
const errorSchema = z.object({ ok: z.literal(false), error: z.string().optional() });

export type SheetRow = z.infer<typeof rowSchema>;

async function callWebApp(init?: RequestInit): Promise<unknown> {
  const url = init?.method === "POST" ? env.SHEET_WEBAPP_URL : `${env.SHEET_WEBAPP_URL}?token=${encodeURIComponent(env.SHEET_WEBAPP_TOKEN)}`;
  const res = await fetch(url, { redirect: "follow", ...init });
  const text = await res.text();

  if (!res.ok) {
    // 403 aqui quase sempre significa implantação com acesso restrito
    // ("Qualquer pessoa com Conta do Google" em vez de "Qualquer pessoa").
    throw new Error(`Web app da planilha respondeu ${res.status}. Confira a implantação do Apps Script.`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Web app da planilha devolveu algo que não é JSON (${text.slice(0, 120)}...)`);
  }

  const failure = errorSchema.safeParse(json);
  if (failure.success) {
    throw new Error(`Web app da planilha recusou a chamada: ${failure.data.error ?? "sem detalhe"}`);
  }
  return json;
}

/** Todas as linhas com link, na ordem da planilha. Quem filtra é o pipeline. */
export async function fetchSheetRows(): Promise<SheetRow[]> {
  const json = await callWebApp();
  const parsed = listSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Resposta do web app fora do formato esperado. O script da planilha foi alterado?");
  }
  return parsed.data.rows;
}

/** Escreve na coluna Status. Falha aqui não pode derrubar o ciclo: o envio já aconteceu. */
export async function markSheetStatus(row: number, status: string): Promise<boolean> {
  try {
    const json = await callWebApp({
      method: "POST",
      // text/plain evita preflight/preview do Apps Script; e.postData chega igual.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: env.SHEET_WEBAPP_TOKEN, row, status }),
    });
    return ackSchema.safeParse(json).success;
  } catch (err) {
    logger.error({ row, err: (err as Error).message }, "Falha ao marcar status na planilha");
    return false;
  }
}
