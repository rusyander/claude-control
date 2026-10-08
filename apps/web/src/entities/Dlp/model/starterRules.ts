import type { DlpBuiltinPattern, DlpRule } from '@agentdeck/contracts';
import { DLP_BUILTINS } from './rules.constants';
import { newBuiltinRule } from './newBuiltinRule';

export type BuiltinNames = Record<DlpBuiltinPattern, string>;

/**
 * Стартовый набор: все встроенные образцы. Словаря здесь нет намеренно —
 * пустой словарь сервер не сохраняет (правило без слов не работает), поэтому
 * страница добавляет его отдельно, черновиком, чтобы человек его заполнил.
 */
export function starterRules(names: BuiltinNames, labels: BuiltinNames): DlpRule[] {
  return DLP_BUILTINS.map((builtin) => newBuiltinRule(builtin, names[builtin], labels[builtin]));
}
