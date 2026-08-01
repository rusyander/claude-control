import type { ModelPricing, PricingEntry } from '@claude-control/contracts';

/**
 * Тарифы API за миллион токенов — нужны, чтобы перевести потраченные токены
 * в понятную величину.
 *
 * ВАЖНО: при подписке деньги за токены не списываются, лимиты считаются иначе.
 * Поэтому цифра стоимости — справочная: «столько же работы через API стоило бы
 * вот столько». Интерфейс обязан подписывать её как оценку, а не как счёт.
 *
 * Прайс меняется, а зашитые в код цифры устаревают молча — и это не гипотеза:
 * таблица из трёх строк (opus/sonnet/haiku) считала opus по $15/$75, тогда как
 * Opus 4.8 стоит $5/$25, то есть завышала втрое. Поэтому настоящий прайс
 * подтягивается с сайта Anthropic (`pricing-source.ts`), а таблица ниже —
 * запасной вариант на случай, когда сети нет.
 *
 * Сам тариф (`ModelPricing`) и строка прайса (`PricingEntry`) описаны в контракте
 * (`packages/contracts/src/app-settings.ts`) — здесь они переэкспортируются, чтобы
 * не держать вторую копию тех же полей.
 *
 * `cacheWrite1h` (часовая запись кэша) пуст у строки ПРАЙСА — ставка выводится из
 * пятиминутной по {@link LONG_CACHE_RATIO}, это опубликованное правило, а не
 * догадка. Пусто у СВОЕЙ цены из настроек — берётся введённая пятиминутная как
 * есть, см. {@link withOwnLongCacheRate}.
 */
export type { ModelPricing, PricingEntry };

/**
 * Во сколько раз часовая запись кэша дороже пятиминутной. Обе ставки прайса —
 * доли базового входа: 1.25× за 5 минут и 2× за час, отсюда 1.6. На встроенной
 * таблице это соотношение выполняется точно (opus 4.8: 6.25 → 10), поэтому
 * вывод по множителю не выдумывает цену, а повторяет опубликованное правило.
 */
const LONG_CACHE_RATIO = 2 / 1.25;

/**
 * Часовая ставка строки ПРАЙСА: своя, если источник её дал, иначе выведенная из
 * пятиминутной. Округление снимает двоичный мусор (6.25 × 1.6 = 10.000000000000002),
 * который иначе вылезал бы в таблице настроек как «$10.00» вместо «$10».
 */
export function longCacheRate(price: ModelPricing): number {
  if (price.cacheWrite1h !== undefined) return price.cacheWrite1h;
  return Math.round(price.cacheWrite * LONG_CACHE_RATIO * 1e6) / 1e6;
}

/**
 * Часовая ставка СВОЕЙ цены пользователя. Множитель здесь запрещён: цена задана
 * руками и означает ровно то, что введено. Пока часовое поле не существовало,
 * `estimateCost` домножал введённую пятиминутную на 1.6 — набранные $6.25
 * превращались в $10 (+59.6 % на реальных транскриптах, где часовым кэшем
 * записано 99 % объёма), и ни одно поле интерфейса этого не показывало.
 * Не знаем часовую — берём введённую как есть, а не придумываем.
 */
export function withOwnLongCacheRate(price: ModelPricing): ModelPricing {
  return price.cacheWrite1h === undefined ? { ...price, cacheWrite1h: price.cacheWrite } : price;
}

/** Откуда взят прайс и когда. Панель показывает это рядом с ценами. */
export interface PricingSnapshot {
  entries: PricingEntry[];
  source: 'anthropic' | 'built-in';
  /** Когда прайс получен (ISO). У встроенного — дата сборки таблицы. */
  fetchedAt: string;
  /** Адрес источника — чтобы было видно, чему верить. */
  url?: string;
}

/** Дата, на которую собрана запасная таблица. */
const BUILT_IN_AT = '2026-07-19T00:00:00.000Z';

/**
 * Запасной прайс — снимок официальной таблицы на {@link BUILT_IN_AT}.
 * Используется, пока не получен свежий: без сети панель всё равно считает,
 * просто по ценам на день сборки.
 */
export const BUILT_IN_ENTRIES: PricingEntry[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', price: p(10, 50, 1, 12.5) },
  { id: 'claude-mythos-5', label: 'Claude Mythos 5', price: p(10, 50, 1, 12.5) },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', price: p(5, 25, 0.5, 6.25) },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', price: p(5, 25, 0.5, 6.25) },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', price: p(5, 25, 0.5, 6.25) },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', price: p(5, 25, 0.5, 6.25) },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', price: p(15, 75, 1.5, 18.75) },
  { id: 'claude-opus-4', label: 'Claude Opus 4', price: p(15, 75, 1.5, 18.75) },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    price: p(2, 10, 0.2, 2.5),
    until: '2026-08-31',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    price: p(3, 15, 0.3, 3.75),
    from: '2026-09-01',
  },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', price: p(3, 15, 0.3, 3.75) },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', price: p(3, 15, 0.3, 3.75) },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', price: p(3, 15, 0.3, 3.75) },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', price: p(1, 5, 0.1, 1.25) },
  { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', price: p(0.8, 4, 0.08, 1) },
];

export const BUILT_IN_SNAPSHOT: PricingSnapshot = {
  entries: BUILT_IN_ENTRIES,
  source: 'built-in',
  fetchedAt: BUILT_IN_AT,
};

/** Короткая запись строки прайса — таблица выше и так плотная. */
function p(input: number, output: number, cacheRead: number, cacheWrite: number): ModelPricing {
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Ставка для модели, о которой в прайсе ничего нет. Взяты стандартные цены
 * Sonnet: середина линейки — ошибка в обе стороны выходит наименьшей.
 */
const FALLBACK: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Семейства моделей — по ним идёт откат, когда точная версия не опознана. */
const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const;

/**
 * Имя модели к виду, пригодному для сравнения: нижний регистр, всё лишнее —
 * в дефисы. Так `claude-opus-4-8[1m]` и `claude-opus-4-8-20260101` одинаково
 * приводятся к строке, содержащей `claude-opus-4-8`.
 */
function normalize(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Старое написание имени: `claude-haiku-3-5` ↔ `claude-3-5-haiku`. До Claude 4
 * версия шла перед семейством, и без этой пары транскрипты тех лет не находили
 * бы свою строку прайса и считались бы по цене актуальной модели семейства.
 */
function legacyId(id: string): string | undefined {
  const match = /^claude-([a-z]+)-([\d-]+)$/.exec(id);
  return match ? `claude-${match[2]}-${match[1]}` : undefined;
}

/** Версия модели числом — чтобы выбрать самую свежую в семействе. */
function version(id: string): number {
  const digits = id.replace(/^claude-/, '').replace(/[a-z]+/g, '');
  const parts = digits.split('-').filter(Boolean);
  return Number(`${parts[0] ?? 0}.${parts[1] ?? 0}`);
}

/** Строки прайса, действующие на указанный момент. */
function activeAt(entries: PricingEntry[], at: number): PricingEntry[] {
  return entries.filter((entry) => {
    // Дату сравниваем как границу суток: `until: '2026-08-31'` означает
    // «включительно», а не «до полуночи 31-го».
    //
    // Границы — именно UTC (в отличие от byDay-группировки в scanner.ts, которая
    // локальная). Это осознанно: `from`/`until` — это даты смены цены из графика
    // Anthropic, единого для всех часовых поясов, а не «полночь у пользователя».
    // Привязка к UTC делает переключение цены детерминированным и независимым от
    // пояса панели; на итоговую стоимость это не влияет — она считается по
    // абсолютному моменту записи (`at`), а не по локальной дате. Смена цены может
    // разойтись с локальной полуночью пользователя максимум на ~половину суток,
    // что для справочной («сколько стоило бы через API») оценки допустимо.
    if (entry.from && at < Date.parse(`${entry.from}T00:00:00.000Z`)) return false;
    if (entry.until && at > Date.parse(`${entry.until}T23:59:59.999Z`)) return false;
    return true;
  });
}

/**
 * Строка прайса для модели: сначала точная версия, затем — самая свежая модель
 * того же семейства.
 *
 * Точную версию ищем от самого длинного идентификатора: `claude-opus-4` —
 * подстрока `claude-opus-4-8`, и при обходе в произвольном порядке Opus 4.8
 * посчитался бы по цене Opus 4 (втрое дороже).
 */
export function findEntry(
  model: string,
  entries: PricingEntry[],
  at: number = Date.now(),
): PricingEntry | undefined {
  const name = normalize(model);
  if (!name) return undefined;

  const candidates = activeAt(entries, at);

  const exact = [...candidates]
    .sort((a, b) => b.id.length - a.id.length)
    .find((entry) => name.includes(entry.id) || includesLegacy(name, entry.id));
  if (exact) return exact;

  const family = FAMILIES.find((item) => name.includes(item));
  if (!family) return undefined;

  return candidates
    .filter((entry) => entry.id.includes(family))
    .sort((a, b) => version(b.id) - version(a.id))[0];
}

function includesLegacy(name: string, id: string): boolean {
  const legacy = legacyId(id);
  return legacy !== undefined && name.includes(legacy);
}

export interface PricingLookup {
  /**
   * Свои цены из настроек: фрагмент имени модели → цена. Перебивают прайс —
   * пользователь мог договориться о своих условиях либо считать по-своему.
   */
  overrides?: Record<string, ModelPricing>;
  /** Прайс, по которому считаем. Пусто — запасная встроенная таблица. */
  entries?: PricingEntry[];
  /**
   * Момент, на который берётся цена. Важен для исторических данных: у Sonnet 5
   * до 31.08.2026 действует вводная цена $2/$10, дальше — $3/$15.
   */
  at?: number;
}

/**
 * Тариф модели. Порядок: свои цены из настроек → прайс → запасная таблица →
 * ставка для неизвестной модели.
 */
export function getPricing(model: string, lookup: PricingLookup = {}): ModelPricing {
  const name = model.toLowerCase();

  // При нескольких подходящих фрагментах побеждает самый длинный (самый точный),
  // как и в findEntry по id: для overrides {opus, 'claude-opus-4-8'} и модели
  // claude-opus-4-8 берём цену точного 'claude-opus-4-8', а не общего 'opus'.
  // Порядок ключей объекта на выбор не влияет.
  const own = Object.entries(lookup.overrides ?? {})
    .filter(([fragment]) => name.includes(fragment.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (own) return withOwnLongCacheRate(own[1]);

  const entries = lookup.entries ?? BUILT_IN_ENTRIES;
  return findEntry(model, entries, lookup.at)?.price ?? FALLBACK;
}

export function estimateCost(
  model: string,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    /**
     * Сколько из `cacheCreation` записано в ЧАСОВОЙ кэш. Это доля, а не
     * слагаемое: общий объём записи остаётся в `cacheCreation`, здесь — та его
     * часть, что тарифицируется по дорогой ставке.
     */
    cacheCreation1h?: number;
  },
  lookup: PricingLookup = {},
): number {
  const price = getPricing(model, lookup);
  const perMillion = 1_000_000;

  // Долю зажимаем в границы целого: транскрипт пишет не панель, и рассогласование
  // полей usage не должно давать отрицательную стоимость.
  const long = Math.min(Math.max(tokens.cacheCreation1h ?? 0, 0), tokens.cacheCreation);
  const short = tokens.cacheCreation - long;
  // getPricing уже проставил часовую ставку своей цене (как введена), поэтому
  // множитель ниже достаётся только строкам прайса без часовой колонки.
  const longRate = longCacheRate(price);

  return (
    (tokens.input * price.input) / perMillion +
    (tokens.output * price.output) / perMillion +
    (tokens.cacheRead * price.cacheRead) / perMillion +
    (short * price.cacheWrite) / perMillion +
    (long * longRate) / perMillion
  );
}
