import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';
import { BUILT_IN_SNAPSHOT, type PricingEntry, type PricingSnapshot } from './pricing.ts';

/**
 * Живой прайс Anthropic.
 *
 * Публичного API с ценами у Anthropic нет, поэтому берём официальную страницу
 * документации: она отдаётся в markdown и содержит таблицу со всеми четырьмя
 * нужными колонками. Источник первичный — цены на нём меняются в день анонса.
 *
 * Разбор намеренно осторожный: колонки ищутся по заголовкам, а не по номерам,
 * и любая неожиданность в разметке приводит к отказу разбора, а не к тихо
 * неверным числам. Не разобрали — остаёмся на прошлом кэше или на встроенной
 * таблице; стоимость в панели справочная, и показать вчерашнюю цену не страшно,
 * а показать выдуманную — страшно.
 */
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

/** Сутки. Прайс меняется в день анонса модели — чаще ходить незачем. */
export const PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Сеть не должна подвешивать открытие настроек. */
const FETCH_TIMEOUT_MS = 10_000;

const CACHE_FILE = 'pricing-cache.json';

/** Колонки таблицы, которые нам нужны, и как их узнать в заголовке. */
const COLUMNS: Array<{ field: keyof PricingEntry['price']; matches: string }> = [
  { field: 'input', matches: 'base input' },
  { field: 'cacheWrite', matches: '5m cache' },
  { field: 'cacheRead', matches: 'cache hits' },
  { field: 'output', matches: 'output' },
];

/**
 * Разбор markdown-таблицы «Model pricing».
 *
 * Возвращает пустой список, если таблица не найдена или в ней нет нужных
 * колонок: вызывающий трактует это как неудачу и не трогает прошлые данные.
 */
export function parsePricingTable(markdown: string): PricingEntry[] {
  const rows = markdown.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));

  const headerIndex = rows.findIndex((row) => row.toLowerCase().includes('base input'));
  if (headerIndex < 0) return [];

  const header = splitRow(rows[headerIndex]!).map((cell) => cell.toLowerCase());
  const columnOf = new Map<keyof PricingEntry['price'], number>();

  for (const column of COLUMNS) {
    // «output» встречается и в «Output Tokens», и внутри других заголовков
    // (например, гипотетическая колонка «Batch Output» слева) — берём ПОСЛЕДНЕЕ
    // совпадение, оно и есть колонка вывода. findIndex брал первое и уводил
    // цену вывода в чужую колонку.
    const index = lastIndexMatching(header, column.matches);
    if (index < 0) return [];
    columnOf.set(column.field, index);
  }

  const entries: PricingEntry[] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const cells = splitRow(row);
    // Строка-разделитель `|---|---|` и всё, что короче заголовка.
    if (cells.length < header.length || /^:?-+:?$/.test(cells[0] ?? '')) continue;

    const entry = parseRow(cells, columnOf);
    // Таблица цен идёт до первого чужого блока: как только строка перестала
    // быть ценой, дальше уже другая таблица (пакетные цены, токены на tool use).
    if (!entry) break;
    entries.push(entry);
  }

  return entries;
}

/** Индекс ПОСЛЕДНЕЙ ячейки заголовка, содержащей подстроку. -1, если нет. */
function lastIndexMatching(header: string[], needle: string): number {
  for (let index = header.length - 1; index >= 0; index -= 1) {
    if (header[index]!.includes(needle)) return index;
  }
  return -1;
}

/** `| a | b |` → `['a', 'b']`. Крайние пустые ячейки от обрамляющих палок. */
function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseRow(
  cells: string[],
  columnOf: Map<keyof PricingEntry['price'], number>,
): PricingEntry | undefined {
  const price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const [field, index] of columnOf) {
    const amount = parseAmount(cells[index] ?? '');
    if (amount === undefined) return undefined;
    price[field] = amount;
  }

  const named = parseModelCell(cells[0] ?? '');
  if (!named) return undefined;

  return { ...named, price };
}

/** `$6.25 / MTok` → 6.25. Без знака доллара считаем, что это не цена. */
function parseAmount(cell: string): number | undefined {
  const match = /\$\s*([\d.]+)/.exec(cell);
  if (!match) return undefined;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Ячейка с названием модели → идентификатор, подпись и срок действия цены.
 *
 * В прайсе это, например: `Claude Opus 4.1 ([deprecated](/docs/…))` или
 * `Claude Sonnet 5 [through August 31, 2026](…)` — у Sonnet 5 две строки,
 * вводная и последующая, и различить их можно только по этой приписке.
 */
export function parseModelCell(
  cell: string,
): Pick<PricingEntry, 'id' | 'label' | 'from' | 'until'> | undefined {
  // Ссылки схлопываем в их текст: срок действия написан именно текстом ссылки.
  let text = cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Скобочные пометки («deprecated», «limited availability») к цене не относятся.
  text = text.replace(/\([^)]*\)/g, '').trim();

  let from: string | undefined;
  let until: string | undefined;

  const through = /\bthrough\s+(.+)$/i.exec(text);
  if (through) {
    until = toIsoDate(through[1]!);
    text = text.slice(0, through.index).trim();
  }

  const starting = /\bstarting\s+(.+)$/i.exec(text);
  if (starting) {
    from = toIsoDate(starting[1]!);
    text = text.slice(0, starting.index).trim();
  }

  const label = text.replace(/\s+/g, ' ').trim();
  if (!label.toLowerCase().startsWith('claude')) return undefined;

  const id = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return { id, label, from, until };
}

/**
 * `August 31, 2026` → `2026-08-31`. Не разобрали — срок просто не ставим.
 *
 * Дату собираем из ЛОКАЛЬНЫХ полей, а не через `toISOString()`: `Date.parse`
 * читает такую запись как локальную полночь, и к UTC она у нас съезжает на
 * день назад — вводная цена закончилась бы на сутки раньше срока.
 */
function toIsoDate(raw: string): string | undefined {
  const time = Date.parse(raw.trim());
  if (Number.isNaN(time)) return undefined;

  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Скачать и разобрать прайс. Бросает, если не вышло, — решает вызывающий. */
export async function fetchPricing(url = PRICING_URL): Promise<PricingSnapshot> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Прайс недоступен: HTTP ${response.status}`);

  const entries = parsePricingTable(await response.text());
  if (entries.length === 0)
    throw new Error('Таблица цен не найдена — разметка страницы изменилась');

  return { entries, source: 'anthropic', fetchedAt: new Date().toISOString(), url };
}

/**
 * Прайс для расчётов: кэш с диска, при устаревании — попытка обновиться.
 *
 * Сеть здесь необязательна. Неудача не бросает исключение и не стирает кэш:
 * аналитика продолжает считать по последним известным ценам, а интерфейс
 * покажет, какой они давности.
 */
export class PricingStore {
  private readonly cacheFile: string;
  private snapshot: PricingSnapshot;
  /** Идущая загрузка — чтобы параллельные запросы не дёргали сеть по разу каждый. */
  private inFlight: Promise<PricingSnapshot> | undefined;

  constructor(appDataDir: string) {
    // Node в режиме strip-only не поддерживает parameter properties.
    this.cacheFile = join(appDataDir, CACHE_FILE);
    this.snapshot = this.readCache();
  }

  private readCache(): PricingSnapshot {
    const cached = readJsonFile<PricingSnapshot | undefined>(this.cacheFile, undefined);
    // Пустой или битый кэш не должен обнулить расчёт стоимости.
    if (!cached?.entries?.length) return BUILT_IN_SNAPSHOT;
    return cached;
  }

  /** Что сейчас в силе — без обращения к сети. */
  current(): PricingSnapshot {
    return this.snapshot;
  }

  isStale(maxAgeMs = PRICING_MAX_AGE_MS): boolean {
    if (this.snapshot.source !== 'anthropic') return true;
    return Date.now() - Date.parse(this.snapshot.fetchedAt) > maxAgeMs;
  }

  /**
   * Обновить, если пора. `force` — по кнопке в настройках.
   * Возвращает актуальный прайс в любом случае, даже когда обновиться не вышло.
   */
  async refresh(options: { force?: boolean; maxAgeMs?: number } = {}): Promise<PricingSnapshot> {
    if (!options.force && !this.isStale(options.maxAgeMs)) return this.snapshot;

    this.inFlight ??= this.load();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async load(): Promise<PricingSnapshot> {
    try {
      const fresh = await fetchPricing();
      this.snapshot = fresh;
      writeJsonFile(this.cacheFile, fresh);
    } catch {
      // Молча: отсутствие сети — обычное дело для локальной панели, а цифра
      // стоимости справочная. Давность источника видна в настройках.
    }
    return this.snapshot;
  }
}
