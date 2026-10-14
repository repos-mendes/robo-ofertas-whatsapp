import Fastify, { type FastifyInstance } from "fastify";
import { env, settings } from "./config.js";
import { logger } from "./logger.js";
import { getLastPreview, runCycle } from "./pipeline/run.js";
import { channels } from "./registry.js";

/**
 * Camada HTTP mínima, escutando SÓ em 127.0.0.1.
 *
 * Existe por dois motivos: dar um /health inspecionável hoje, e permitir que um
 * orquestrador externo (n8n, por exemplo) assuma o agendamento amanhã chamando
 * POST /run — sem que a lógica precise mudar de lugar. As rotas são cascas
 * finas sobre as mesmas funções que o cron usa.
 */

const HOST = "127.0.0.1";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Mesmo preso ao loopback, exige token: qualquer processo local — inclusive
  // uma aba de navegador — alcançaria a porta de outra forma.
  app.addHook("onRequest", async (request, reply) => {
    if (!env.HTTP_TOKEN) {
      return reply.code(503).send({ error: "HTTP_TOKEN não configurado no .env; API desabilitada" });
    }
    if (request.headers["x-api-token"] !== env.HTTP_TOKEN) {
      return reply.code(401).send({ error: "token inválido" });
    }
  });

  app.get("/health", async () => {
    const channelStatus = await Promise.all(
      channels.map(async (c) => ({ id: c.id, ...(await c.status()) })),
    );

    return {
      ok: true,
      dryRun: env.DRY_RUN,
      schedule: settings.schedule,
      sheet: { configured: Boolean(env.SHEET_WEBAPP_URL && env.SHEET_WEBAPP_TOKEN) },
      channels: channelStatus,
    };
  });

  app.get("/deals", async () => runCycle({ preview: true }));

  app.post<{ Body: { dryRun?: boolean } | undefined }>("/run", async (request, reply) => {
    try {
      return await runCycle({ dryRun: request.body?.dryRun });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  // Serve a última prévia sem recalcular — útil para inspecionar o que o cron acabou de fazer.
  app.get("/deals/last", async () => ({ offers: getLastPreview() }));

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ host: HOST, port: env.HTTP_PORT });

  if (!env.HTTP_TOKEN) {
    logger.warn("HTTP_TOKEN vazio: a API responderá 503 até você definir um valor no .env");
  }
  logger.info({ url: `http://${HOST}:${env.HTTP_PORT}` }, "API local no ar");
  return app;
}
