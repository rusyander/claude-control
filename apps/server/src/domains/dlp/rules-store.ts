import { DlpRulesError, parseRules, rulesFileSchema, rulesPath } from '@agentdeck/dlp/rules-file';
import { compileRulePattern } from '@agentdeck/dlp/rules';
import { writeJsonFile } from '../../lib/safe-io/safe-io.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/**
 * Запись правил — только у панели: чтение и разбор формы живут в пакете DLP
 * (`@agentdeck/dlp/rules-file`), их зовёт и ядро, а править файл может лишь тот,
 * у кого есть атомарная запись и тексты отказов, — сервер.
 */

/**
 * Проверить набор до записи: форма по схеме, своё выражение разбирается,
 * встроенный образец выбран, словарь не пуст, идентификаторы не повторяются.
 * Повтор идентификатора не «косметика»: панель правит и удаляет правила по
 * id, и две карточки с одним id двигались бы вместе.
 */
export function validateRules(rules: readonly unknown[]): string | undefined {
  const parsed = parseRules(rules);
  if (parsed instanceof DlpRulesError) return parsed.message;

  const seen = new Set<string>();
  for (const rule of parsed) {
    if (seen.has(rule.id)) return serverText('dlp-rule-id-duplicate', { name: rule.name });
    seen.add(rule.id);

    if (rule.kind === 'regex' && !compileRulePattern(rule.pattern)) {
      return serverText('dlp-rule-regex-broken', { name: rule.name });
    }
    if (rule.kind === 'builtin' && !rule.builtin) {
      return serverText('dlp-rule-no-builtin', { name: rule.name });
    }
    if (rule.kind === 'terms' && rule.terms.filter((term) => term.trim()).length === 0) {
      return serverText('dlp-rule-dictionary-empty', { name: rule.name });
    }
  }
  return undefined;
}

export function saveRules(appDataDir: string, rules: readonly unknown[]): void {
  const problem = validateRules(rules);
  if (problem) throw new DlpRulesError(problem);

  // Пишем РАЗОБРАННЫЕ правила, а не присланные: файл читает ещё и скрипт хука,
  // у которого нет схемы. Недостающее поле там стало бы догадкой.
  const parsed = rulesFileSchema.safeParse({ version: 1, rules });
  if (!parsed.success)
    throw coded(new DlpRulesError('правила не соответствуют схеме'), 'dlp-rules-schema');
  writeJsonFile(rulesPath(appDataDir), parsed.data);
}
