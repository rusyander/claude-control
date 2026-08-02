import type { KimiDecision, KimiPermissionRule } from '@claude-control/contracts';

/** Строка формы: `id` нужен, чтобы строки не «прыгали» при вводе. */
export interface KimiRuleRow {
  id: number;
  decision: KimiDecision;
  pattern: string;
}

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

/** Черновик для сервера: пустые шаблоны выбрасываются, порядок сохраняется. */
export const toKimiRules = (rows: readonly KimiRuleRow[]): KimiPermissionRule[] =>
  rows
    .map((row) => ({ decision: row.decision, pattern: row.pattern.trim() }))
    .filter((rule) => rule.pattern.length > 0);

/** Нормализованный слепок правил — по нему считается «есть правки». Порядок значим. */
export const stableKimiRules = (rules: readonly KimiPermissionRule[]): string =>
  JSON.stringify(rules.map((rule) => [rule.decision, rule.pattern]));
