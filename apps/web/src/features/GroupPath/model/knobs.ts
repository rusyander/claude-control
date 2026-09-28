import type { KnobView } from '@agentdeck/contracts';

/** Значение списка «Авто»: число не задано, решает скилл. */
export const KNOB_AUTO = 'auto';

/**
 * «Авто» — у группы своего значения нет, число выбирает скилл. Закреплённое
 * число — своё, даже если равно умолчанию скилла: скилл поменяет умолчание,
 * а группа останется при своём.
 */
export function isAutoKnob(knob: Pick<KnobView, 'auto'>): boolean {
  return knob.auto;
}

/** Значение списка для числа: «Авто» или закреплённое число строкой. */
export function knobSelectValue(knob: KnobView): string {
  return isAutoKnob(knob) ? KNOB_AUTO : String(knob.value);
}

/**
 * Закреплённое число вне min..max: после новой выписки скилла размах мог
 * сузиться, а значение группы сервер не трогает — прогон берёт его как есть.
 * Список обязан его показать; без своего пункта select молча показывал «Авто».
 */
export function knobOutOfRange(knob: KnobView): number | undefined {
  if (isAutoKnob(knob)) return undefined;
  return knob.value < knob.min || knob.value > knob.max ? knob.value : undefined;
}

/** Числа списка: от min до max — выбирают, а не набирают. */
export function knobNumbers(knob: Pick<KnobView, 'min' | 'max'>): number[] {
  const numbers: number[] = [];
  for (let value = knob.min; value <= knob.max; value += 1) numbers.push(value);
  return numbers;
}

/** Выбор в списке → тело PUT: `null` — вернуть «Авто», число — закрепить. */
export function knobEditValue(selected: string): number | null {
  if (selected === KNOB_AUTO) return null;
  const value = Number(selected);
  return Number.isInteger(value) ? value : null;
}

/** Подпись числа на языке интерфейса; пустая — ключ, чтобы поле не было безымянным. */
export function knobLabel(knob: KnobView, language: string): string {
  const own = language.startsWith('en') ? knob.label.en : knob.label.ru;
  const other = language.startsWith('en') ? knob.label.ru : knob.label.en;
  return own.trim() || other.trim() || knob.key;
}
