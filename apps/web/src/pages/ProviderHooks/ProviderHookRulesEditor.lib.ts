import type { ProviderHookRule } from '@claude-control/contracts';
import { nextRowId } from './ProviderHooks.lib';
import type { RuleRow } from './ProviderHookRulesEditor.types';

export function toRow(rule: ProviderHookRule): RuleRow {
  return {
    id: nextRowId(),
    event: rule.event,
    matcher: rule.matcher ?? '',
    command: rule.command,
    timeout: rule.timeout === undefined ? '' : String(rule.timeout),
  };
}

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
