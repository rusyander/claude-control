import type { CommandResult } from '@agentdeck/contracts';

/** Состояние мутации команды, которого хватает, чтобы выбрать последнюю. */
export interface CommandRun {
  data?: CommandResult;
  submittedAt: number;
}

/**
 * Итог последней ОТПРАВЛЕННОЙ команды из нескольких. Цепочка `a.data ?? b.data`
 * брала первую по списку, а не последнюю по времени: успех тумблера закрывал
 * позже случившийся отказ обновления (ревью 28.09, F-249).
 */
export function lastResult(runs: readonly CommandRun[]): CommandResult | undefined {
  let latest: CommandRun | undefined;
  for (const run of runs) {
    if (run.data && (!latest || run.submittedAt > latest.submittedAt)) latest = run;
  }
  return latest?.data;
}
