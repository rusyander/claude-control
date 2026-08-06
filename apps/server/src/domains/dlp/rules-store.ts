import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { object, string, boolean, array, number, enum as zodEnum } from 'zod';
import type { DlpRule } from '@claude-control/contracts';
import { writeJsonFile } from '../../lib/safe-io.ts';
import { compileRulePattern } from './rules.ts';

/**
 * Правила на диске — файл панели, не чужой формат.
 *
 * Лежат ОТДЕЛЬНО от `state.json` намеренно: в словарях правил стоят настоящие
 * фамилии, телефоны и адреса — то есть ровно те данные, которые правила и
 * защищают. Настройки панели переносятся между машинами экспортом; словарь
 * персональных данных ездить вместе с ними не должен.
 *
 * Схема повторяет `dlpRuleSchema` из contracts — по той же причине, что и
 * `providers/settings-validation.ts`: contracts входит в сервер только типами.
 */

const FILE = 'dlp-rules.json';

const ruleSchema = object({
  id: string().min(1),
  name: string().min(1),
  enabled: boolean().default(true),
  kind: zodEnum(['builtin', 'terms', 'regex']),
  builtin: zodEnum(['email', 'phone_ru', 'inn', 'snils', 'card', 'secret_key']).optional(),
  terms: array(string()).default([]),
  pattern: string().default(''),
  action: zodEnum(['mask', 'block', 'flag']).default('mask'),
  label: string().default('ДАННЫЕ'),
});

const fileSchema = object({ version: number().default(1), rules: array(ruleSchema).default([]) });

export class DlpRulesError extends Error {}

function rulesPath(appDataDir: string): string {
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
    throw new DlpRulesError(`файл правил не разбирается (${(error as Error).message})`);
  }

  const result = fileSchema.safeParse(parsed);
  if (!result.success) throw new DlpRulesError('файл правил не соответствует схеме');
  return result.data.rules;
}

/** Проверить набор до записи: своё выражение обязано разбираться. */
export function validateRules(rules: readonly DlpRule[]): string | undefined {
  for (const rule of rules) {
    if (rule.kind === 'regex' && !compileRulePattern(rule.pattern)) {
      return `правило «${rule.name}»: выражение не разбирается`;
    }
    if (rule.kind === 'builtin' && !rule.builtin) {
      return `правило «${rule.name}»: не выбран встроенный образец`;
    }
    if (rule.kind === 'terms' && rule.terms.filter((term) => term.trim()).length === 0) {
      return `правило «${rule.name}»: словарь пуст`;
    }
  }
  return undefined;
}

export function saveRules(appDataDir: string, rules: readonly DlpRule[]): void {
  const problem = validateRules(rules);
  if (problem) throw new DlpRulesError(problem);

  // Пишем РАЗОБРАННЫЕ правила, а не присланные: файл читает ещё и скрипт хука,
  // у которого нет схемы. Недостающее поле там стало бы догадкой.
  const parsed = fileSchema.safeParse({ version: 1, rules });
  if (!parsed.success) throw new DlpRulesError('правила не соответствуют схеме');
  writeJsonFile(rulesPath(appDataDir), parsed.data);
}
