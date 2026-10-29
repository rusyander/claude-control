import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { object, string, boolean, array, number, enum as zodEnum } from 'zod';
import type { DlpRule } from '@agentdeck/contracts';
import { coded } from '@agentdeck/contracts/server-messages';
import { DLP_BUILTIN_IDS } from './builtins.mjs';

/**
 * Правила на диске — файл панели, не чужой формат.
 *
 * Лежат ОТДЕЛЬНО от `state.json` намеренно: в словарях правил стоят настоящие
 * фамилии, телефоны и адреса — то есть ровно те данные, которые правила и
 * защищают. Настройки панели переносятся между машинами экспортом; словарь
 * персональных данных ездить вместе с ними не должен.
 *
 * Здесь — чтение и разбор формы: их зовут и панель, и ядро (маска при записи в
 * журнал). Смысловая проверка набора и запись файла — у панели
 * (`apps/server/src/domains/dlp/rules-store.ts`): только она правит правила.
 *
 * Схема повторяет `dlpRuleSchema` из contracts — по той же причине, что и
 * `providers/settings-validation/settings-validation.ts` сервера.
 */

const FILE = 'dlp-rules.json';

const ruleSchema = object({
  id: string().min(1),
  name: string().min(1),
  enabled: boolean().default(true),
  kind: zodEnum(['builtin', 'terms', 'regex']),
  builtin: zodEnum(DLP_BUILTIN_IDS).optional(),
  terms: array(string()).default([]),
  pattern: string().default(''),
  action: zodEnum(['mask', 'block', 'flag']).default('mask'),
  label: string().default('ДАННЫЕ'),
});

export const rulesFileSchema = object({
  version: number().default(1),
  rules: array(ruleSchema).default([]),
});

export class DlpRulesError extends Error {}

export function rulesPath(appDataDir: string): string {
  return join(appDataDir, FILE);
}

/**
 * Прочитать правила. Файл битый — это ОШИБКА, а не «правил нет»: прокси,
 * поднявшийся с пустым списком после порчи файла, пропустил бы наружу всё,
 * сообщив при этом, что защита работает.
 */
export function readRules(appDataDir: string): DlpRule[] {
  const path = rulesPath(appDataDir);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw coded(
      new DlpRulesError(`файл правил не разбирается (${(error as Error).message})`),
      'dlp-rules-unparsed',
      { reason: (error as Error).message },
    );
  }

  const result = rulesFileSchema.safeParse(parsed);
  if (!result.success)
    throw coded(new DlpRulesError('файл правил не соответствует схеме'), 'dlp-rules-schema-file');
  return result.data.rules;
}

/**
 * Разобрать присланный список по схеме — только форма, без смысловых проверок.
 * Для предпросмотра этого достаточно: черновик с пустым словарём просто ничего
 * не найдёт, а вот `null` вместо правила раньше ронял маршрут в 500.
 */
export function parseRules(rules: readonly unknown[]): DlpRule[] | DlpRulesError {
  const out: DlpRule[] = [];
  for (const [index, raw] of rules.entries()) {
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success)
      return coded(
        new DlpRulesError(`${nameOf(raw, index)}: не соответствует схеме`),
        'dlp-rule-schema',
        { rule: nameOf(raw, index) },
      );
    out.push(parsed.data);
  }
  return out;
}

function nameOf(raw: unknown, index: number): string {
  const name = (raw as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? `правило «${name}»` : `правило №${index + 1}`;
}
