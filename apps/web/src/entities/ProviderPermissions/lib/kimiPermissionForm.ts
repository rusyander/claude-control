import type { KimiPermissionRule } from '@agentdeck/contracts';
import type { KimiRuleRow } from './kimiPermissionForm.types';

/**
 * Идентификатор — позиция, а не монотонный счётчик, и это осознанно: форма
 * пересобирает строки при каждом новом ответе сервера. Монотонные значения
 * давали бы новый ключ каждой строке, React перемонтировал бы поля и ввод терял
 * бы фокус. Позиция при пересборке та же, поэтому строки стоят на месте.
 * Добавление строки берёт `max(id) + 1` — в пределах ОДНОГО списка этого
 * достаточно, а ключи React сравниваются только между соседями.
 */
export const toKimiRuleRows = (rules: readonly KimiPermissionRule[]): KimiRuleRow[] =>
  rules.map((rule, index) => ({ id: index, decision: rule.decision, pattern: rule.pattern }));
