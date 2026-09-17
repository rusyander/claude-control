import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';

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

/** Ручная цена: модель, которой в прайсе нет, и её ставки. */
export interface ManualPrice {
  /** Фрагмент имени, как его сверяет расчёт (`findPricing`): строчными. */
  model: string;
  price: ModelPricing;
}

/**
 * Свои цены, которые не относятся ни к одной строке прайса, — ручные.
 *
 * Решение по контуру №7: каталог платформы компании цены Qwen3.8 не отдаёт, и оценка
 * расхода через контур стояла на 0 $ при списании 0,46 $. Такой цене нет строки
 * в прайсе Anthropic — без этого списка она сохранялась бы и работала невидимой,
 * а человек не знал бы, по какой цифре считается оценка.
 */
export function manualPrices(
  custom: Record<string, ModelPricing>,
  entries: readonly PricingEntry[],
): ManualPrice[] {
  return Object.entries(custom)
    .filter(([fragment]) => !entries.some((entry) => entry.id.includes(fragment)))
    .map(([model, price]) => ({ model, price }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Ручная цена из формы. Для модели компании обычно известны только вход и
 * выход: незаданный кэш берётся равным входу — так шлюз без отдельной цены кэша
 * и берёт деньги за эти токены (`declaredPricing` на сервере).
 */
export function manualPriceFromDraft(draft: PricingDraft): ModelPricing | undefined {
  const input = (draft.input ?? '').trim();
  const orInput = (value: string | undefined): string => ((value ?? '').trim() ? value! : input);
  return priceFromDraft({
    ...draft,
    cacheRead: orInput(draft.cacheRead),
    cacheWrite: orInput(draft.cacheWrite),
  });
}

/**
 * Свои цены после добавления ручной. Имя — строчными и без пробелов по краям:
 * расчёт сверяет фрагмент с именем модели без учёта регистра, и «Qwen3.8 » с
 * пробелом не совпал бы ни с чем. Пустое имя — `undefined`, а не цена на всё.
 */
export function withManualPrice(
  custom: Record<string, ModelPricing>,
  model: string,
  price: ModelPricing,
): Record<string, ModelPricing> | undefined {
  const key = model.trim().toLowerCase();
  if (!key) return undefined;
  return { ...custom, [key]: price };
}

/** Свои цены без одной записи. */
export function withoutCustom(
  custom: Record<string, ModelPricing>,
  key: string,
): Record<string, ModelPricing> {
  return Object.fromEntries(Object.entries(custom).filter(([fragment]) => fragment !== key));
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
