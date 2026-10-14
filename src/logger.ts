import { mkdirSync } from "node:fs";
import pino from "pino";
import { env, paths } from "./config.js";

mkdirSync(paths.logs, { recursive: true });

/**
 * Log vai para o console e para logs/app.log ao mesmo tempo. O arquivo é o que
 * permite descobrir, no dia seguinte, por que o robô parou de postar às 3h da
 * manhã — o console do Agendador de Tarefas do Windows não fica visível.
 */
export const logger = pino(
  { level: env.LOG_LEVEL },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: `${paths.logs}/app.log`, append: true, sync: false }) },
  ]),
);

export type Logger = typeof logger;
