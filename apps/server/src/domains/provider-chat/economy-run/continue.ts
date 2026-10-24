import type { EconomyRunInput } from './economy-run.types.ts';

/** Потолок вывода оболочки `Bash`, знаки (умолчание `cn` — 50 000). */
export const CONTINUE_BASH_OUTPUT_ENV = 'CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS';
/** Потолок чтения файла `Read`, знаки (умолчание `cn` — 100 000). */
export const CONTINUE_READ_OUTPUT_ENV = 'CONTINUE_CLI_READ_FILE_MAX_OUTPUT_CHARS';

/** Знаков на токен — та же мера, что у Codex и Goose. */
const CHARS_PER_TOKEN = 4;

/**
 * Канал Continue (`cn`): два потолка — две переменные окружения, которые `cn`
 * читает при каждом вызове инструмента; конфиг человека не трогается. Каждый
 * ответ — свой запуск `cn -p`, поэтому переменная доходит до него без условий.
 *
 * Живая проба 22.10.2026 (`cn` 1.5.47, заглушка OpenAI, временный дом):
 * - вывод оболочки 6000 знаков при потолке 3000 пришёл модели обрезанным
 *   (3038 знаков с пометкой), без потолка — целиком;
 * - файл 6000 знаков при потолке чтения 3000 не прочитан вовсе: модель получила
 *   отказ с советом читать частями (`head`, `sed`, `grep`), — так же, как
 *   чтение Claude сверх своего предела.
 *
 * Рычаг чтения задан в токенах, а `cn` меряет знаками: токены × 4. Ноль —
 * «не трогать», своя переменная просто не ставится (ключи независимы — в
 * отличие от Codex и Goose, где один ключ на все инструменты).
 */
export function continueEconomyEnv(input: EconomyRunInput): Record<string, string> | undefined {
  const economy = input.economy;
  if (!economy) return undefined;
  const env: Record<string, string> = {};
  const bash = Math.ceil(economy.bashOutputChars);
  if (Number.isSafeInteger(bash) && bash > 0) env[CONTINUE_BASH_OUTPUT_ENV] = String(bash);
  const read = Math.ceil(economy.readOutputTokens * CHARS_PER_TOKEN);
  if (Number.isSafeInteger(read) && read > 0) env[CONTINUE_READ_OUTPUT_ENV] = String(read);
  return Object.keys(env).length > 0 ? env : undefined;
}
