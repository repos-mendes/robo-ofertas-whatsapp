import { env, settings } from "./config.js";
import { logger } from "./logger.js";
import { closeAll } from "./registry.js";
import { startScheduler } from "./scheduler.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  logger.info({ dryRun: env.DRY_RUN, schedule: settings.schedule }, "Robô de ofertas iniciando");

  if (env.DRY_RUN) {
    logger.warn("DRY_RUN ativo: as mensagens serão impressas no console, não enviadas ao WhatsApp");
  }

  const server = await startServer();
  const task = startScheduler();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Encerrando");

    await task.stop();
    await server.close().catch(() => {});
    await closeAll();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Um erro solto não pode matar o processo em silêncio: sem ele, a sessão do
  // WhatsApp cai e o robô fica fora do ar até alguém reparar.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "Promise rejeitada sem tratamento");
  });
  process.on("uncaughtException", (err: Error) => {
    logger.error({ err: err.message, stack: err.stack }, "Exceção não capturada");
  });

  logger.info("Robô no ar. Aguardando o próximo horário agendado.");
}

void main().catch((err: Error) => {
  logger.error({ err: err.message }, "Falha ao iniciar");
  process.exit(1);
});
