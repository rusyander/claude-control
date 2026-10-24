import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import { CODEX_COMPACT_LIMIT_ENV, CODEX_TOOL_OUTPUT_LIMIT_ENV } from '../../kit/codex.ts';
import type { EconomyRunInput } from './economy-run.types.ts';

/** Знаков на токен — мера решения O2: потолок оболочки в знаках делится на четыре. */
const CHARS_PER_TOKEN = 4;
/**
 * Собственный предел Codex без ключа, токены. Живая проба 22.10.2026, codex-cli
 * 0.155.1, заглушка модели, вывод команды 40 000 знаков: без ключа до модели
 * дошло 10 218 знаков (то же у gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2,
 * gpt-4.1), с ключом 500 — 2 218, 2 500 — 10 218, 10 000 — 40 113. То есть
 * умолчание — 2 500 токенов, а ключ его и поднимает: рычаги по умолчанию
 * (8 000 знаков, 10 000 токенов чтения) дали бы 10 000 и вчетверо раздули бы
 * ответы инструментов.
 */
export const CODEX_DEFAULT_TOOL_OUTPUT_TOKENS = 2_500;

/**
 * Канал Codex: рычаги уходят переменными `AGENTDECK_CODEX_*`, а `withCodexKit`
 * (`kit/codex.ts`) снимает их с окружения и превращает в ключи `-c` запуска —
 * конфиг человека не трогается.
 *
 * Порог сжатия группы (6.2) — тот же рычаг A/B, что окно Claude (2.1): порог в
 * токенах у Codex документирован (`model_auto_compact_token_limit`). Перенесён
 * сюда из `runtime.ts` без изменения поведения: окно читается на ходу, ключ
 * появляется только у группы и только с ненулевым окном.
 *
 * Потолок ответа инструмента — `tool_output_token_limit`, см. `codexToolOutputLimit`.
 */
export function codexEconomyEnv(input: EconomyRunInput): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (input.compactWindow) env[CODEX_COMPACT_LIMIT_ENV] = String(input.compactWindow);
  const toolOutput = codexToolOutputLimit(input.economy);
  if (toolOutput) env[CODEX_TOOL_OUTPUT_LIMIT_ENV] = String(toolOutput);
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * У Codex один предел на ответ ЛЮБОГО инструмента (токены), а у групп два рычага:
 * вывод оболочки (знаки) и чтение файла (токены). Берётся больший (решение O2):
 * предел оболочки не должен урезать чтение, иначе модель дочитывала бы файл
 * лишними ходами — дороже, чем сэкономили.
 *
 * Ноль у любого из двух — «этот инструмент не трогать, решает CLI»: одним ключом
 * нельзя оставить один инструмент на умолчании CLI, урезав другой, поэтому ключа
 * нет вовсе. Рычаг экономии только ужимает: предел не ниже собственного предела
 * Codex (`CODEX_DEFAULT_TOOL_OUTPUT_TOKENS`) — ключа нет, CLI и так строже.
 * Рычаги закреплены на первом старте разговора — ключ запуска не меняется
 * посреди тёплой сессии.
 */
export function codexToolOutputLimit(economy: GroupEconomy | undefined): number | undefined {
  if (!economy) return undefined;
  const bash = economy.bashOutputChars;
  const read = economy.readOutputTokens;
  if (!(bash > 0) || !(read > 0)) return undefined;
  const limit = Math.max(Math.ceil(bash / CHARS_PER_TOKEN), Math.ceil(read));
  if (!Number.isSafeInteger(limit) || limit <= 0) return undefined;
  return limit < CODEX_DEFAULT_TOOL_OUTPUT_TOKENS ? limit : undefined;
}
