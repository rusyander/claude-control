import type { ModelPricing, PricingEntry } from '@claude-control/contracts';

/**
 * Строка карточки «Тарифы»: что показать, что положить в форму и что сохранить.
 *
 * Вынесено из компонента ради часовой ставки записи кэша. Она в прайсе —
 * ОТДЕЛЬНАЯ колонка (2× базового входа против 1.25× у пятиминутной), и на
 * реальных транскриптах по ней проходит 99% объёма записи. Пока карточка правила
 * четыре поля, своя цена пользователя часовой ставки не несла вовсе, а расчёт
 * домножал введённую пятиминутную на 1.6: набранные $6.25 превращались в счёте
 * в $10, и ни одно поле этого не показывало.
 *
 * Правило здесь одно: НИЧЕГО не выводим множителем. Часовая ставка приходит с
 * сервера уже проставленной (для прайса — по опубликованному правилу, для своей
 * цены — равной введённой пятиминутной). Не пришла — показываем прочерк, а не
 * придуманное число.
 */

/** Порядок колонок таблицы и полей формы. */
export const PRICING_FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'cacheWrite1h',
] as const satisfies ReadonlyArray<keyof ModelPricing>;

export type PricingField = (typeof PRICING_FIELDS)[number];

/** Набранное в форме — строками: пока печатают, число может быть неполным. */
export type PricingDraft = Partial<Record<PricingField, string>>;

/** Форма для правки строки: пустое поле — «ставка неизвестна», а не ноль. */
export function draftFromPrice(price: ModelPricing): PricingDraft {
  const draft: PricingDraft = {};

  for (const field of PRICING_FIELDS) {
    const value = price[field];
    draft[field] = value === undefined ? '' : String(value);
  }

  return draft;
}

/**
 * Цена из набранного. Мусор и отрицательные числа — не цена: сервер такое
 * отклонит, и молча «сохранённая» строка осталась бы прежней. Пустая часовая
 * ставка допустима — она необязательна, и её отсутствие означает «как введена
 * пятиминутная», а не ноль.
 */
export function priceFromDraft(draft: PricingDraft): ModelPricing | undefined {
  const required = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  const price: Partial<Record<PricingField, number>> = {};

  for (const field of required) {
    const value = parseRate(draft[field]);
    if (value === undefined) return undefined;
    price[field] = value;
  }

  const long = (draft.cacheWrite1h ?? '').trim();
  if (long) {
    const value = parseRate(long);
    if (value === undefined) return undefined;
    price.cacheWrite1h = value;
  }

  return price as ModelPricing;
}

/**
 * Свои цены после сохранения строки. Прежние ключи-фрагменты («opus») убираем:
 * иначе рядом жили бы две своих цены на одну модель, и какая победит — зависело
 * бы от порядка ключей. Совпало с прайсом — не храним вовсе: пусть работает
 * цена с сайта, тогда обновление принесёт свежую само.
 */
export function nextCustom(
  custom: Record<string, ModelPricing>,
  entry: PricingEntry,
  price: ModelPricing,
): Record<string, ModelPricing> {
  const next = Object.fromEntries(
    Object.entries(custom).filter(([fragment]) => !entry.id.includes(fragment)),
  );

  if (!samePrice(price, entry.price)) next[entry.id] = price;
  return next;
}

/** Своя цена для строки прайса: точное совпадение либо заданный раньше фрагмент. */
export function overrideFor(
  custom: Record<string, ModelPricing>,
  id: string,
): ModelPricing | undefined {
  return Object.entries(custom).find(([fragment]) => id.includes(fragment))?.[1];
}

function samePrice(a: ModelPricing, b: ModelPricing): boolean {
  return PRICING_FIELDS.every((field) => a[field] === b[field]);
}

function parseRate(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
