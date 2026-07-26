/**
 * Числовое поле настроек: ввод отдельно, сохранение отдельно.
 *
 * Раньше поле было целиком подчинено сохранённому значению, а патч уходил
 * только когда введённое уже попадало в границы. У «Ожидания сети» границы
 * 2000…120000, и ни один префикс допустимого числа сам по себе не ≥ 2000:
 * набранная «5» сохранение не вызывала, React возвращал в поле старое
 * значение — и напечатать новое было нельзя вообще, оставались только стрелки.
 *
 * Разводим два шага. Пока печатают, поле показывает набранное как есть, а
 * сохраняем лишь то, что уже годится. Когда поле покидают — доводим набранное
 * до ближайшего допустимого, а пустое возвращаем к сохранённому.
 */

export interface NumberSettingRules {
  min: number;
  max: number;
}

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

/**
 * Значение, с которым поле остаётся после потери фокуса: набранное, подтянутое
 * к границам, либо прежнее сохранённое, если набрана пустота или мусор.
 */
export function commitNumberSetting(raw: string, rules: NumberSettingRules, saved: number): number {
  const parsed = parseNumber(raw);
  if (parsed === undefined) return saved;

  return Math.min(rules.max, Math.max(rules.min, Math.floor(parsed)));
}

function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
