import type { RuleRow } from './ProviderHookRulesEditor.types';
import type { ProviderHookRule } from '@agentdeck/contracts';

/**
 * Строка формы → правило для сервера. Строка без команды выпадает целиком: она
 * появляется, когда правило добавили и не заполнили, и отправлять её значило бы
 * получить 400 на ровном месте. Таймаут не число → поле просто не отправляется.
 */
export function toDraft(row: RuleRow, supportsMatcher: boolean): ProviderHookRule | undefined {
  const command = row.command.trim();
  if (!command) return undefined;

  const rule: ProviderHookRule = { event: row.event, command };
  const matcher = row.matcher.trim();
  if (matcher && supportsMatcher) rule.matcher = matcher;

  const timeout = Number(row.timeout.trim());
  if (row.timeout.trim() && Number.isInteger(timeout)) rule.timeout = timeout;

  return rule;
}
