import type { DlpRule, DlpBuiltinPattern } from '@agentdeck/contracts';
import { DLP_BUILTINS } from './rules.constants';

/**
 * Образцы, которых в наборе нет ни одним правилом. Набор, собранный до Р11,
 * знает шесть образцов из двадцати, и без этой подсказки новые не появились бы
 * у человека никогда: стартовый набор предлагается только пустому разделу.
 */
export function missingBuiltins(rules: readonly DlpRule[]): DlpBuiltinPattern[] {
  const present = new Set(rules.map((rule) => rule.builtin).filter(Boolean));
  return DLP_BUILTINS.filter((builtin) => !present.has(builtin));
}
