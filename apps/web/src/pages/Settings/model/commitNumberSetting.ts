import type { NumberSettingRules } from './NumberSetting.types';
import { parseNumber } from './parseNumber';

/**
 * Значение, с которым поле остаётся после потери фокуса: набранное, подтянутое
 * к границам, либо прежнее сохранённое, если набрана пустота или мусор.
 */
export function commitNumberSetting(raw: string, rules: NumberSettingRules, saved: number): number {
  const parsed = parseNumber(raw);
  if (parsed === undefined) return saved;

  return Math.min(rules.max, Math.max(rules.min, Math.floor(parsed)));
}
