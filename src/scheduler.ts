import cron, { type ScheduledTask } from "node-cron";
import { settings } from "./config.js";
import { logger } from "./logger.js";
import { runCycle } from "./pipeline/run.js";

/**
 * O cron vive DENTRO do processo, e não como tarefa disparada de fora, porque
 * o Baileys precisa de um processo vivo para manter a sessão do WhatsApp. Um
 * processo por execução exigiria reparear a cada ciclo.
 */
export function startScheduler(): ScheduledTask {
  if (!cron.validate(settings.schedule)) {
    throw new Error(`Expressão cron inválida em config.json: "${settings.schedule}"`);
  }

  const task = cron.schedule(
    settings.schedule,
    () => {
      void runCycle()
        .then((summary) => {
          logger.info(
            { published: summary.published, failed: summary.failed, durationMs: summary.durationMs },
            "Ciclo agendado concluído",
          );
        })
        .catch((err: Error) => {
          // Nunca relança: uma exceção aqui derrubaria o processo e, com ele, a
          // sessão do WhatsApp — o robô ficaria fora do ar até alguém notar.
          logger.error({ err: err.message }, "Ciclo agendado falhou");
        });
    },
    { timezone: "America/Sao_Paulo" },
  );

  logger.info({ schedule: settings.schedule, timezone: "America/Sao_Paulo" }, "Agendador iniciado");
  return task;
}
