import type { NumberSettingRules } from './NumberSetting.types';
import { parseNumber } from './parseNumber';

/** Шаг ввода: что показать в поле и что сохранить (если уже есть что). */
export interface NumberSettingStep {
  text: string;
  value?: number;
}

export function typeNumberSetting(raw: string, rules: NumberSettingRules): NumberSettingStep {
  const parsed = parseNumber(raw);
  const isSavable =
    parsed !== undefined &&
    parsed >= rules.min &&
    parsed <= rules.max &&
    parsed === Math.floor(parsed);

  return { text: raw, value: isSavable ? parsed : undefined };
}
