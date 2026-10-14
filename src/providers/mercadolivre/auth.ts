import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config.js";
import { readToken, writeToken, type StoredToken } from "../../db.js";
import { logger } from "../../logger.js";

export const PROVIDER_ID = "mercadolivre";

const AUTH_BASE = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

/** Renova com folga: o access token vale 6h, mas trocamos 5 min antes de expirar. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user_id?: number;
  scope?: string;
}

// --- PKCE --------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// --- Fluxo de autorização (roda uma única vez, via scripts/ml-auth.ts) -------

export function buildAuthUrl(challenge?: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.ML_CLIENT_ID,
    redirect_uri: env.ML_REDIRECT_URI,
  });
  if (challenge) {
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  return `${AUTH_BASE}?${params.toString()}`;
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      // O ML exige os parâmetros no corpo, não na querystring.
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Mercado Livre recusou o token (HTTP ${response.status}): ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

function persist(payload: TokenResponse): StoredToken {
  // Sem o scope `offline_access` o ML devolve access_token mas nenhum
  // refresh_token — e a integração morreria 6h depois, sem explicação. O erro
  // nativo daqui seria um "cannot be bound to SQLite parameter 3", que não
  // ajuda ninguém; falhamos antes, dizendo o que fazer.
  if (!payload.refresh_token) {
    throw new Error(
      "O Mercado Livre não devolveu refresh_token. A aplicação precisa do scope `offline_access`: " +
        "portal > Minhas aplicações > sua aplicação > scopes. Ative, salve e rode `npm run ml:auth` de novo.",
    );
  }
  if (!payload.access_token) {
    throw new Error("Resposta do Mercado Livre sem access_token — não há o que gravar.");
  }

  const token: StoredToken = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  writeToken(PROVIDER_ID, token);
  return token;
}

export async function exchangeCode(code: string, verifier?: string): Promise<StoredToken> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    code,
    redirect_uri: env.ML_REDIRECT_URI,
  };
  if (verifier) body.code_verifier = verifier;
  return persist(await requestToken(body));
}

// --- Uso em runtime ----------------------------------------------------------

let inFlight: Promise<StoredToken> | null = null;

async function refresh(refreshToken: string): Promise<StoredToken> {
  logger.debug("Renovando access token do Mercado Livre");
  const payload = await requestToken({
    grant_type: "refresh_token",
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  // Cada refresh devolve um refresh_token NOVO e invalida o anterior. Se este
  // gravar falhar, a integração morre em silêncio na próxima renovação — por
  // isso persist() grava os dois campos numa transação só.
  return persist(payload);
}

/**
 * Devolve um access token válido, renovando se necessário. Chamadas
 * concorrentes compartilham a mesma renovação: dois refreshes simultâneos com
 * o mesmo refresh_token fariam o segundo falhar e derrubariam a sessão.
 */
export async function getAccessToken(): Promise<string> {
  const stored = readToken(PROVIDER_ID);
  if (!stored) {
    throw new Error(
      "Nenhum token do Mercado Livre encontrado. Rode `npm run ml:auth` uma vez para autorizar a aplicação.",
    );
  }

  if (Date.now() < stored.expiresAt - REFRESH_MARGIN_MS) {
    return stored.accessToken;
  }

  inFlight ??= refresh(stored.refreshToken).finally(() => {
    inFlight = null;
  });

  return (await inFlight).accessToken;
}

/** Usado pelo endpoint /health. */
export function tokenStatus(): { present: boolean; expiresAt: number | null } {
  const stored = readToken(PROVIDER_ID);
  return { present: stored !== null, expiresAt: stored?.expiresAt ?? null };
}
