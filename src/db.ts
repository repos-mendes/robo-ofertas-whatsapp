import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./config.js";

/**
 * Usa o SQLite embutido no Node (>=22.5) em vez de better-sqlite3, o que evita
 * exigir node-gyp/MSVC no Windows. O módulo ainda é marcado como experimental,
 * então TODO acesso ao banco passa por este arquivo: se um dia for preciso
 * trocar por better-sqlite3, muda-se só aqui.
 */

mkdirSync(paths.data, { recursive: true });

export const db = new DatabaseSync(paths.db);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider      TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_history (
    provider    TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    price       REAL NOT NULL,
    captured_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_price_history_item
    ON price_history (provider, item_id, captured_at);

  CREATE TABLE IF NOT EXISTS posted (
    provider   TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    posted_at  INTEGER NOT NULL,
    price      REAL NOT NULL,
    PRIMARY KEY (provider, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_posted_at ON posted (posted_at);

  CREATE TABLE IF NOT EXISTS affiliate_links (
    source_url    TEXT PRIMARY KEY,
    affiliate_url TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
`);

export const now = (): number => Date.now();

// --- Tokens OAuth ------------------------------------------------------------

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch em ms. */
  expiresAt: number;
}

export function readToken(provider: string): StoredToken | null {
  const row = db
    .prepare("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?")
    .get(provider) as { access_token: string; refresh_token: string; expires_at: number } | undefined;
  if (!row) return null;
  return { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at };
}

export function writeToken(provider: string, token: StoredToken): void {
  db.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       updated_at    = excluded.updated_at`,
  ).run(provider, token.accessToken, token.refreshToken, token.expiresAt, now());
}

// --- Histórico de preço ------------------------------------------------------

export function recordPrice(provider: string, itemId: string, price: number): void {
  db.prepare("INSERT INTO price_history (provider, item_id, price, captured_at) VALUES (?, ?, ?, ?)").run(
    provider,
    itemId,
    price,
    now(),
  );
}

export function recordPrices(entries: ReadonlyArray<{ provider: string; itemId: string; price: number }>): void {
  const stmt = db.prepare("INSERT INTO price_history (provider, item_id, price, captured_at) VALUES (?, ?, ?, ?)");
  const ts = now();
  db.exec("BEGIN");
  try {
    for (const e of entries) stmt.run(e.provider, e.itemId, e.price, ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface PriceStats {
  points: number;
  min: number;
  median: number;
}

/**
 * Estatísticas da janela recente. A mediana (e não a média) é usada de
 * propósito: um único dia de preço absurdo — comum no ML — não desloca a
 * mediana, mas destruiria a média e faria o robô considerar oferta o que é
 * preço normal.
 */
export function priceStats(provider: string, itemId: string, windowDays: number): PriceStats | null {
  const since = now() - windowDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT price FROM price_history
       WHERE provider = ? AND item_id = ? AND captured_at >= ?
       ORDER BY price ASC`,
    )
    .all(provider, itemId, since) as Array<{ price: number }>;

  if (rows.length === 0) return null;

  const prices = rows.map((r) => r.price);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0 ? ((prices[mid - 1] as number) + (prices[mid] as number)) / 2 : (prices[mid] as number);

  return { points: prices.length, min: prices[0] as number, median };
}

/** Remove histórico antigo para o banco não crescer indefinidamente. */
export function prunePriceHistory(keepDays: number): number {
  const cutoff = now() - keepDays * 24 * 60 * 60 * 1000;
  const result = db.prepare("DELETE FROM price_history WHERE captured_at < ?").run(cutoff);
  return Number(result.changes);
}

// --- Controle de publicação --------------------------------------------------

export interface PostRecord {
  postedAt: number;
  price: number;
}

export function lastPost(provider: string, itemId: string): PostRecord | null {
  const row = db.prepare("SELECT posted_at, price FROM posted WHERE provider = ? AND item_id = ?").get(provider, itemId) as
    | { posted_at: number; price: number }
    | undefined;
  return row ? { postedAt: row.posted_at, price: row.price } : null;
}

export function markPosted(provider: string, itemId: string, price: number): void {
  db.prepare(
    `INSERT INTO posted (provider, item_id, posted_at, price) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, item_id) DO UPDATE SET posted_at = excluded.posted_at, price = excluded.price`,
  ).run(provider, itemId, now(), price);
}

/** Quantos itens já foram publicados nas últimas 24h (todos os providers). */
export function postsInLast24h(): number {
  const since = now() - 24 * 60 * 60 * 1000;
  const row = db.prepare("SELECT COUNT(*) AS n FROM posted WHERE posted_at >= ?").get(since) as { n: number };
  return row.n;
}

// --- Cache de links de afiliado ---------------------------------------------

export function readAffiliateLink(sourceUrl: string): string | null {
  const row = db.prepare("SELECT affiliate_url FROM affiliate_links WHERE source_url = ?").get(sourceUrl) as
    | { affiliate_url: string }
    | undefined;
  return row?.affiliate_url ?? null;
}

export function writeAffiliateLink(sourceUrl: string, affiliateUrl: string): void {
  db.prepare(
    `INSERT INTO affiliate_links (source_url, affiliate_url, created_at) VALUES (?, ?, ?)
     ON CONFLICT(source_url) DO UPDATE SET affiliate_url = excluded.affiliate_url`,
  ).run(sourceUrl, affiliateUrl, now());
}
