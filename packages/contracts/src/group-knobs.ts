import { object, string, number, array, record, type infer as Infer } from 'zod';
import { localizedTextSchema } from './group-path.ts';

/**
 * «Числа» группы — сколько прогонов делает скилл-участник: кругов ревью,
 * агентов на круг, проверяющих, сравнений с макетом и т. п.
 *
 * Сами числа живут в тексте скилла («≤100 файлов → 2 полосы»), и панель их не
 * придумывает: при чтении группы дешёвая модель выписывает из текста скилла
 * настраиваемые числа с ЦИТАТОЙ, а сервер берёт только те, чья цитата дословно
 * есть в тексте и содержит само число. Кэш — по хэшу содержимого скилла.
 *
 * Человек меняет число у ГРУППЫ, скилл не правится. У каждого числа два
 * состояния: «Авто» (значения у группы нет — скилл решает сам и вправе выбрать
 * не то, что написано в его тексте) и закреплённое число — оно уходит в каждый
 * прогон строкой «группа задаёт: …» и берётся ровно таким, без вопроса
 * человеку. Закрепить можно и само умолчание скилла: это уже не «Авто».
 */

export const knobSchema = object({
  /** Устойчивый ключ внутри скилла, латиница: `review-rounds`. */
  key: string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  skillId: string().min(1),
  label: localizedTextSchema,
  /** Число из текста скилла — значение по умолчанию. */
  default: number().int(),
  min: number().int(),
  max: number().int(),
  /** Строка текста скилла, из которой взято число, — дословно. */
  quote: string().min(1).max(400),
});
export type Knob = Infer<typeof knobSchema>;

/**
 * Сколько чисел самое большее в списке ручки. Список — нативный select от min
 * до max: модель, назвавшая 0..20000, давала двадцать тысяч пунктов и вешала
 * страницу; правило промпта «max не больше четырёх умолчаний» она соблюдает не всегда.
 */
export const KNOB_MAX_OPTIONS = 50;

/**
 * Границы ручки, зажатые на сервере: min не ниже нуля (и не выше умолчания),
 * max не выше четырёх умолчаний (и не ниже умолчания), а весь размах — не
 * длиннее `KNOB_MAX_OPTIONS`, окном вокруг умолчания.
 */
export function clampKnobRange<T extends Pick<Knob, 'default' | 'min' | 'max'>>(knob: T): T {
  const base = knob.default;
  let min = Math.min(Math.max(knob.min, Math.min(0, base)), base);
  let max = Math.max(Math.min(knob.max, Math.max(base * 4, 4)), base);
  if (max - min + 1 > KNOB_MAX_OPTIONS) {
    min = Math.max(min, base - Math.floor((KNOB_MAX_OPTIONS - 1) / 2));
    max = Math.min(max, min + KNOB_MAX_OPTIONS - 1);
    min = Math.max(knob.min, Math.min(0, base), max - KNOB_MAX_OPTIONS + 1);
  }
  if (min === knob.min && max === knob.max) return knob;
  return { ...knob, min, max };
}

/** Ключ числа у группы: `<skillId>:<key>`. */
export function knobId(knob: Pick<Knob, 'skillId' | 'key'>): string {
  return `${knob.skillId}:${knob.key}`;
}

/** Что хранится у группы: закреплённые числа; нет записи — «Авто». */
export const groupKnobValuesSchema = record(string(), number().int());
export type GroupKnobValues = Infer<typeof groupKnobValuesSchema>;

export interface KnobView extends Knob {
  /** Закреплённое число, а при «Авто» — умолчание скилла (для показа). */
  value: number;
  /** «Авто»: у группы нет значения — скилл решает сам, строки в прогоне нет. */
  auto: boolean;
  /** Закреплённое число отличается от числа в скилле. */
  overridden: boolean;
  /**
   * Шаг скилла (индекс с нуля, как у шага в пути), к которому число относится:
   * раздел, где стоит цитата, или шаг, названный в ней (`§9`). Нет — к первому.
   * Считает сервер: текст проектного скилла есть только у него, и все числа доставки тикета
   * стояли на шаге 1 вместо ревью и правок (28.09).
   */
  step?: number;
}

export interface GroupKnobsView {
  groupId: string;
  knobs: KnobView[];
  /** Скиллы, у которых выписка ещё идёт (первый показ или смена правил выписки). */
  pending?: string[];
  /**
   * Скиллы, чья выписка недавно не удалась: сбой вызова или пустой ответ при
   * строках-счётчиках в тексте. Не «читается» — панель повторит сама позже.
   */
  failed?: string[];
}

/**
 * `PUT /api/groups/:id/knobs`: число закрепляет значение (и равное умолчанию
 * скилла тоже), `null` — вернуть «Авто».
 */
export const groupKnobsEditSchema = object({
  values: record(string(), number().int().nullable()),
});
export type GroupKnobsEdit = Infer<typeof groupKnobsEditSchema>;

/** Ответ модели на выписку чисел одного скилла. */
export const knobExtractionSchema = object({
  knobs: array(knobSchema.omit({ skillId: true })).default([]),
});
export type KnobExtraction = Infer<typeof knobExtractionSchema>;

/** Сколько чисел берём у одного скилла: больше — это уже не «настройки», а шум. */
export const MAX_KNOBS_PER_SKILL = 6;

/**
 * Число словом — как его пишут в скиллах: «exactly **two** review subagents»,
 * «ревью двумя агентами». Без этого скилл, где все счётчики написаны словами,
 * не давал ни одного числа: цитата была дословной, а цифры в ней не было.
 */
const NUMBER_WORDS: Readonly<Record<number, readonly string[]>> = {
  1: ['one', 'single', 'once', 'один', 'одна', 'одно', 'одного', 'одной', 'одним', 'одному'],
  2: ['two', 'twice', 'два', 'две', 'двух', 'двум', 'двумя', 'дважды'],
  3: ['three', 'thrice', 'три', 'трёх', 'трех', 'трём', 'трем', 'тремя', 'трижды'],
  4: ['four', 'четыре', 'четырёх', 'четырех', 'четырём', 'четырем', 'четырьмя'],
  5: ['five', 'пять', 'пяти', 'пятью'],
  6: ['six', 'шесть', 'шести', 'шестью'],
  7: ['seven', 'семь', 'семи', 'семью'],
  8: ['eight', 'восемь', 'восьми', 'восемью'],
  9: ['nine', 'девять', 'девяти', 'девятью'],
  10: ['ten', 'десять', 'десяти', 'десятью'],
};

/** Число, которое означает слово («two», «двумя», «дважды»); не число — `undefined`. */
export function numberWordValue(word: string): number | undefined {
  const lower = word.toLowerCase();
  for (const [value, words] of Object.entries(NUMBER_WORDS)) {
    if (words.includes(lower)) return Number(value);
  }
  return undefined;
}

/** Разметка выделения, пробелы и регистр не в счёт: модель цитирует «**two**» то со звёздами, то без. */
export function knobPlainText(text: string): string {
  return text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Стоит ли число в цитате — цифрами или отдельным словом (не частью другого слова). */
export function quoteHasNumber(quote: string, value: number): boolean {
  const text = knobPlainText(quote);
  if (new RegExp(`(^|\\D)${value}(\\D|$)`).test(text)) return true;
  return (NUMBER_WORDS[value] ?? []).some((word) =>
    new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, 'u').test(text),
  );
}

/** Есть ли в тексте хоть одно число — цифрами или словом; нет — выписывать нечего. */
export function mentionsNumber(text: string): boolean {
  if (/\d/.test(text)) return true;
  return Object.keys(NUMBER_WORDS).some((value) => quoteHasNumber(text, Number(value)));
}

/**
 * Значение в границах и цитата дословно в тексте с этим числом — иначе выписке
 * не верим: модель могла число придумать. «Дословно» — с точностью до разметки
 * выделения, пробелов и регистра; число — цифрами или словом.
 */
export function knobGrounded(knob: Omit<Knob, 'skillId'>, skillText: string): boolean {
  if (knob.min > knob.default || knob.default > knob.max) return false;
  // Стороны подписи по умолчанию пустые — число без имени на обоих языках
  // показывалось бы пустой строкой (F-332).
  if (!knob.label.ru.trim() && !knob.label.en.trim()) return false;
  const quote = knobPlainText(knob.quote);
  if (!quote || !knobPlainText(skillText).includes(quote)) return false;
  return quoteHasNumber(knob.quote, knob.default);
}
