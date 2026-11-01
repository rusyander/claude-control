/**
 * Фасад команд человека: приём и суд — `commands/process.ts`, применение — файл своего вида
 * `commands/<kind>.ts` через таблицу `commands/apply.ts`. Пути импорта прежние.
 */
export { commandsInFlight, knownOutcome, processCommand } from './commands/process.ts';
export type { ApplyCommand, CommandEnv, CommandResult } from './commands/commands.types.ts';
