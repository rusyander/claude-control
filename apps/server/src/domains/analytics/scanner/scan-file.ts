import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { estimateCost, findPricing } from '../pricing.ts';
import { localDay, normalizeProject, shortenProject } from './keys.ts';
import { addUsage, cacheCreationTokens, emptyTotals, upsert } from './totals.ts';
import type { Accumulator, RawEntry, RawUsage, ScanOptions } from './types.ts';

/**
 * Разбор одного транскрипта. Файл читается построчно потоком: их больше тысячи,
 * отдельные весят десятки мегабайт, и читать их целиком в память нельзя.
 *
 * Строки, которые не разбираются, просто пропускаются: транскрипт активной
 * сессии может дописываться прямо во время чтения, и последняя строка
 * оказывается обрезанной — это нормально, а не повод падать.
 */

/** Сессия считается активной, если её файл менялся за последние 10 минут. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** Строки транскрипта Claude Code — записи как есть; недописанная строка пропускается. */
async function* claudeEntries(lines: AsyncIterable<string>): AsyncGenerator<RawEntry> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawEntry;
    } catch {
      // недописанная строка активной сессии
    }
  }
}

/** Построчное чтение файла потоком. */
export function fileLines(path: string): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  return createInterface({ input: stream, crlfDelay: Infinity });
}

/**
 * Записи одного файла сессии в форме транскрипта Claude Code. Чужой CLI
 * (`foreign.ts`) переводит свои строки в эту же форму — дальше один и тот же
 * учёт: период, повторы ответа, проект, сессия, инструменты.
 */
export type EntrySource = (lines: AsyncIterable<string>) => AsyncIterable<RawEntry>;

export async function scanFile(
  file: { path: string; mtimeMs: number },
  since: number,
  until: number,
  acc: Accumulator,
  options: Pick<ScanOptions, 'pricing' | 'pricingEntries' | 'strictPricing'>,
  source: EntrySource = claudeEntries,
): Promise<void> {
  const isActive = Date.now() - file.mtimeMs < ACTIVE_WINDOW_MS;
  const lines = source(fileLines(file.path));
  /**
   * Отложенные ответы этого файла: ключ — сам ответ модели, значение — САМАЯ
   * ПОЛНАЯ его строка.
   *
   * Claude Code пишет отдельную строку на каждый блок ответа (thinking, text,
   * tool_use) и в каждой повторяет usage целиком — но растущий: input и кэш во
   * всех строках одинаковы, а `output_tokens` дописывается по мере генерации, и
   * полное число несёт последняя строка (замер на реальном ~/.claude: у 17 тысяч
   * ответов выход различался, первая строка занижала его на 35%). Поэтому мало
   * отбросить повторы — нужно выбрать из них максимум и учесть один раз.
   *
   * Карта живёт на файл, а не на весь обход: повторы одного ответа лежат в одном
   * транскрипте, и память не растёт на тысячах файлов.
   */
  const pending = new Map<
    string,
    { entry: RawEntry; usage: RawUsage; time: number; stamp: string }
  >();

  /**
   * Проект сессии — каталог, из которого её запустили: cwd ПЕРВОЙ записи файла,
   * до всякого отбора по периоду. У каждой строки свой cwd, и он меняется с
   * каждым `cd` агента внутри сессии; считать проектом cwd строки значило
   * рассыпать один разговор на десятки «проектов» вроде `node_modules/x/dist`
   * и учитывать сессию в каждом из них (замер на реальном ~/.claude: 64
   * «проекта» из 13 файлов за день).
   */
  let launchCwd: string | undefined;

  /** Учесть один ответ модели во всех разрезах сразу. */
  const count = (entry: RawEntry, usage: RawUsage, time: number, stamp: string): void => {
    const cwd = launchCwd ?? entry.cwd ?? 'unknown';
    const model = entry.message?.model ?? 'unknown';
    const tokens = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: cacheCreationTokens(usage),
      // Часовая доля записи — по своей, более дорогой ставке.
      cacheCreation1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    };
    // Цену берём НА МОМЕНТ записи, а не на сегодня: у части моделей цена
    // менялась по расписанию (вводная цена Sonnet 5), и пересчёт старого
    // расхода по сегодняшнему прайсу дал бы неверную историю.
    const lookup = { overrides: options.pricing, entries: options.pricingEntries, at: time };
    // Модель чужого CLI без цены в прайсе — ноль и пометка «без цены», а не
    // запасная ставка Claude: расход GPT по тарифу Sonnet — выдуманные деньги.
    const unpriced = options.strictPricing === true && !findPricing(model, lookup);
    if (unpriced) acc.unpriced.add(model);
    const cost = unpriced ? 0 : estimateCost(model, tokens, lookup);

    addUsage(acc.overall, usage);
    acc.cost += cost;

    upsert(acc.byModel, model, usage, cost);
    // byDay берётся по ЛОКАЛЬНОЙ дате — как и час ниже (getHours). Иначе одна и
    // та же запись у пользователя в поясе ≠ UTC попадала бы в «день» и «час» из
    // разных суток. На цену это не влияет: стоимость считается по абсолютному
    // моменту записи (estimateCost выше, at: time), а не по ключу группировки.
    upsert(acc.byDay, localDay(stamp), usage, cost);

    const hour = new Date(stamp).getHours();
    const hourly = acc.byHour.get(hour) ?? { requests: 0, tokens: 0 };
    hourly.requests += 1;
    hourly.tokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    acc.byHour.set(hour, hourly);

    trackProject(acc, entry, cwd, usage, cost);
    trackSession(acc, entry, cwd, usage, cost, model, isActive, file.path);
  };

  for await (const entry of lines) {
    launchCwd ??= entry.cwd;

    // Заголовок разговора лежит в записи без метки времени, поэтому читается ДО
    // отсечки по периоду: иначе он не доберётся ни до одной сессии. Побеждает
    // последний — CLI переименовывает разговор по мере работы.
    if (entry.type === 'ai-title' && entry.aiTitle) {
      acc.sessionTitles.set(sessionKey(entry, file.path), entry.aiTitle);
      continue;
    }

    // Период отсекается ДО счётчика инструментов. Раньше инструменты считались
    // по всем строкам файлов, переживших фильтр по mtime: долгоживущий транскрипт
    // с полугодовой историей давал «Топ инструментов» за все 180 дней рядом с
    // графиками токенов за выбранную неделю — две половины одной страницы жили
    // разными периодами. Запись без разбираемой метки времени в период поместить
    // нельзя, поэтому она не учитывается нигде.
    const stamp = entry.timestamp;
    if (!stamp) continue;

    const time = new Date(stamp).getTime();
    if (Number.isNaN(time) || time < since || time > until) continue;

    countTools(entry, acc, file.path);

    const usage = entry.message?.usage;
    if (entry.type !== 'assistant' || !usage) continue;

    // Один ответ модели = message.id + requestId. У старых транскриптов этих
    // полей нет — такие считаем сразу и по строке, как раньше, иначе молча
    // потеряли бы всю их историю.
    const responseKey = `${entry.message?.id ?? ''}|${entry.requestId ?? ''}`;
    if (responseKey === '|') {
      count(entry, usage, time, stamp);
      continue;
    }

    // Побеждает строка с наибольшим выходом, при равенстве — последняя: именно
    // она несёт итоговый usage ответа (см. комментарий к `pending`).
    const best = pending.get(responseKey);
    if (!best || (usage.output_tokens ?? 0) >= (best.usage.output_tokens ?? 0)) {
      pending.set(responseKey, { entry, usage, time, stamp });
    }
  }

  // Порядок вставки Map сохраняется, поэтому ответы учитываются в том же
  // порядке, в каком встретились, — от него зависят «последняя активность»
  // сессии и проекта.
  for (const item of pending.values()) count(item.entry, item.usage, item.time, item.stamp);
}

function trackProject(
  acc: Accumulator,
  entry: RawEntry,
  cwd: string,
  usage: RawUsage,
  cost: number,
): void {
  const project = normalizeProject(cwd);
  const bucket = acc.byProject.get(project) ?? {
    totals: emptyTotals(),
    cost: 0,
    sessions: new Set<string>(),
    lastActivity: entry.timestamp ?? '',
  };

  addUsage(bucket.totals, usage);
  bucket.cost += cost;
  if (entry.sessionId) bucket.sessions.add(entry.sessionId);
  if (entry.timestamp && entry.timestamp > bucket.lastActivity)
    bucket.lastActivity = entry.timestamp;

  acc.byProject.set(project, bucket);
}

function trackSession(
  acc: Accumulator,
  entry: RawEntry,
  cwd: string,
  usage: RawUsage,
  cost: number,
  model: string,
  isActive: boolean,
  filePath: string,
): void {
  const sessionId = sessionKey(entry, filePath);
  const existing = acc.sessions.get(sessionId);

  if (!existing) {
    const totals = emptyTotals();
    addUsage(totals, usage);
    acc.sessions.set(sessionId, {
      sessionId,
      project: normalizeProject(cwd),
      displayName: shortenProject(cwd),
      startedAt: entry.timestamp ?? '',
      lastActivity: entry.timestamp ?? '',
      totals,
      estimatedCost: cost,
      models: [model],
      gitBranch: entry.gitBranch,
      isActive,
    });
    return;
  }

  addUsage(existing.totals, usage);
  existing.estimatedCost += cost;
  if (!existing.models.includes(model)) existing.models.push(model);
  if (entry.timestamp) {
    if (entry.timestamp > existing.lastActivity) existing.lastActivity = entry.timestamp;
    if (entry.timestamp < existing.startedAt) existing.startedAt = entry.timestamp;
  }
}

/** Ключ сессии: номер из записи, а у старых транскриптов без него — имя файла. */
function sessionKey(entry: RawEntry, filePath: string): string {
  return entry.sessionId ?? basename(filePath, '.jsonl');
}

/**
 * Считает вызовы инструментов: видно, чем агент реально пользуется — по всему
 * периоду и отдельно по сессии (из них собирается `topTools` сессии).
 */
function countTools(entry: RawEntry, acc: Accumulator, filePath: string): void {
  for (const part of entry.message?.content ?? []) {
    if (part.type !== 'tool_use' || !part.name) continue;
    acc.tools.set(part.name, (acc.tools.get(part.name) ?? 0) + 1);

    const key = sessionKey(entry, filePath);
    const own = acc.sessionTools.get(key) ?? new Map<string, number>();
    own.set(part.name, (own.get(part.name) ?? 0) + 1);
    acc.sessionTools.set(key, own);
  }
}
