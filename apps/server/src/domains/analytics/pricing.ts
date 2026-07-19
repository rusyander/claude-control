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
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Строка прайса. Цена привязана к КОНКРЕТНОЙ версии модели, а не к семейству:
 * Opus 4.1 стоит втрое дороже Opus 4.8, и считать их одной ценой — врать в
 * разы на старых транскриптах.
 */
export interface PricingEntry {
  /** Идентификатор модели в прайсе: `claude-opus-4-8`. */
  id: string;
  /** Как модель названа в прайсе: «Claude Opus 4.8». Для интерфейса. */
  label: string;
  price: ModelPricing;
  /** Цена действует с этой даты (ISO). Пусто — действовала всегда. */
  from?: string;
  /** Цена действует по эту дату включительно (ISO). Пусто — бессрочно. */
  until?: string;
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

  const own = Object.entries(lookup.overrides ?? {}).find(([fragment]) =>
    name.includes(fragment.toLowerCase()),
  );
  if (own) return own[1];

  const entries = lookup.entries ?? BUILT_IN_ENTRIES;
  return findEntry(model, entries, lookup.at)?.price ?? FALLBACK;
}

export function estimateCost(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
  lookup: PricingLookup = {},
): number {
  const price = getPricing(model, lookup);
  const perMillion = 1_000_000;

  return (
    (tokens.input * price.input) / perMillion +
    (tokens.output * price.output) / perMillion +
    (tokens.cacheRead * price.cacheRead) / perMillion +
    (tokens.cacheCreation * price.cacheWrite) / perMillion
  );
}
