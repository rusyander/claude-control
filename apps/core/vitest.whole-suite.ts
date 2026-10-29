import { parseCLI } from 'vitest/node';

/**
 * «Это прогон всего набора?» по argv vitest — покрытие считает только он (vitest.config.ts).
 * argv разбирает САМ vitest (`parseCLI` — тот же разборщик, что у его командной строки), а не
 * наш список флагов со значением: список отставал от версии vitest (`--diff d.json`,
 * `--configLoader runner`, `--api 51204`, `--inspect-brk 9229` — значение считалось фильтром,
 * и покрытие прогона всего набора молча выключалось; ревью m4, F-80).
 * Частичный прогон — фильтр файлов, `-t`/`--testNamePattern`, `--changed`, `related`/`--related`.
 * argv, который vitest не примет (`--silent src/api`), — не прогон всего набора: vitest сам откажет.
 */
export function isWholeSuite(args: readonly string[]): boolean {
  let parsed: ReturnType<typeof parseCLI>;
  try {
    parsed = parseCLI(['vitest', ...args]);
  } catch {
    return false;
  }
  const { filter, options } = parsed;
  if (filter.length > 0) return false;
  if (options.testNamePattern !== undefined) return false;
  // `--changed` без значения — `true`; со значением — ссылка git: оба сужают набор.
  if (options.changed !== undefined && options.changed !== false) return false;
  if (options.related !== undefined) return false;
  return true;
}
