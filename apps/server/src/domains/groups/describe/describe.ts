import { describeAnswerSchema, type LocalizedLine } from '@agentdeck/contracts/group-describe';
import { readPanelJson, writePanelJson } from '../../../lib/app-store/group-sources.ts';
import { readJsonBlock } from '../answer-block.ts';
import { singleTurn, type GroupAsk } from '../model.ts';

/**
 * Описания ресурсов на двух языках: кэш `<appData>/describe.json` и фоновая
 * очередь вызовов дешёвой модели. Ответ страницы модели не ждёт: готовое — из
 * кэша, остальное ставится в очередь и называется в `pending`. Одновременно
 * идут не больше двух вызовов — открытый каталог из сотни ресурсов не должен
 * съедать окно подписки разом. Неудача повторяется не раньше, чем через
 * десять минут: иначе каждый опрос страницы платил бы заново.
 */

const FILE = 'describe.json';
export const DESCRIBE_BLOCK_KIND = 'group-describe';
/** Версия описания: другая — не кэш (правила описания менялись, текст ресурса — нет). */
export const DESCRIBE_VERSION = 1;
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_RUNNING = 2;

/** Что описывается: текст уже собран и замаскирован, хэш — от него же. */
export interface DescribeSource {
  /** Ключ кэша: `<где>|<вид>:<id>`. */
  key: string;
  kind: string;
  id: string;
  text: string;
  hash: string;
  /** Заголовки нумерованных шагов скилла; пусто — шагов нет. */
  steps: readonly string[];
}

export interface DescribedStep {
  title: LocalizedLine;
  summary: LocalizedLine;
}

export interface DescribeEntry {
  hash: string;
  v: number;
  title: LocalizedLine;
  summary: LocalizedLine;
  /** По индексу шага скилла; описаны только шаги, которые модель назвала. */
  steps?: DescribedStep[];
}

/**
 * Запись, которую показывают, пока идёт новое описание: шаги скилла описаны не
 * все (модель назвала 12 из 14 или разбор шагов стал находить больше).
 */
export type RefreshingEntry = DescribeEntry & { refreshing: true };

type Cache = Record<string, DescribeEntry>;

export interface Describer {
  appData: string;
  ask: GroupAsk;
  /** Промпт каталога `group-describe` с подставленным языком блока. */
  prompt: string;
  onError?: (error: unknown, key: string) => void;
  now?: () => number;
}

export function readDescribeCache(appData: string): Cache {
  return readPanelJson<Cache>(appData, FILE, {});
}

/**
 * Описаны ли все шаги скилла. Хэш текста этого не ловит: текст тот же, а
 * модель назвала меньше шагов, чем в нём есть, или разбор шагов стал находить
 * больше. Такая запись не кэш — иначе последние шаги навсегда оставались бы
 * без описания, английским оригиналом в русском интерфейсе.
 */
function coversSteps(entry: DescribeEntry, source: DescribeSource): boolean {
  return (entry.steps?.length ?? 0) >= source.steps.length;
}

function sameText(
  entry: DescribeEntry | undefined,
  source: DescribeSource,
): entry is DescribeEntry {
  return entry?.hash === source.hash && entry.v === DESCRIBE_VERSION;
}

export function freshEntry(cache: Cache, source: DescribeSource): DescribeEntry | undefined {
  const entry = cache[source.key];
  return sameText(entry, source) && coversSteps(entry, source) ? entry : undefined;
}

const inFlight = new Set<string>();
const failedAt = new Map<string, number>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
let idleWaiters: (() => void)[] = [];

function pump(): void {
  while (running < MAX_RUNNING && queue.length > 0) {
    const job = queue.shift()!;
    running += 1;
    void job().finally(() => {
      running -= 1;
      pump();
    });
  }
  if (running === 0 && queue.length === 0) {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Очередь пуста и ничего не идёт — для тестов и завершения. */
export function describeIdle(): Promise<void> {
  if (running === 0 && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/** Сброс памяти неудач — тестам. */
export function resetDescribeFailures(): void {
  failedAt.clear();
}

/** Сколько неудач помнится — тестам. */
export function describeFailureCount(): number {
  return failedAt.size;
}

/** Шаги скилла в запросе описания — поимённо и с числом: модель не вправе потерять хвост. */
export function describeData(source: DescribeSource): string {
  const head = `${source.kind} ${source.id}:\n${source.text}`;
  if (source.steps.length === 0) return head;
  const list = source.steps.map((title, index) => `${index + 1}. ${title}`).join('\n');
  return (
    `${head}\n\nNumbered steps of this skill (${source.steps.length}). Give exactly ` +
    `${source.steps.length} entries in \`steps\`, one per step, in this order:\n${list}`
  );
}

/** Ответ модели → запись кэша; нечитаемый ответ — ошибка (повтор через окно). */
export function entryFromReply(source: DescribeSource, reply: string): DescribeEntry {
  const parsed = describeAnswerSchema.safeParse(readJsonBlock(reply, DESCRIBE_BLOCK_KIND));
  if (!parsed.success) throw new Error(`describe ${source.key}: unreadable answer`);
  const { title, summary, steps } = parsed.data;
  const kept = source.steps.length > 0 ? steps.slice(0, source.steps.length) : [];
  return {
    hash: source.hash,
    v: DESCRIBE_VERSION,
    title,
    summary,
    ...(kept.length > 0 ? { steps: kept } : {}),
  };
}

async function describeOne(describer: Describer, source: DescribeSource): Promise<void> {
  const reply = await describer.ask(singleTurn(describer.prompt, describeData(source)), 'cheap');
  const entry = entryFromReply(source, reply);
  // Перечитываем перед записью: пока шёл вызов, мог записаться соседний ресурс.
  const cache = readDescribeCache(describer.appData);
  const before = cache[source.key];
  const keptBefore = sameText(before, source) ? (before.steps?.length ?? 0) : -1;
  // Неполный ответ не затирает более полный прежний того же текста.
  if ((entry.steps?.length ?? 0) >= keptBefore) {
    cache[source.key] = entry;
    writePanelJson(describer.appData, FILE, cache);
  }
  if (!coversSteps(entry, source)) {
    // Неполное — ошибка: повтор через окно, а до него показывается то, что есть.
    throw new Error(
      `describe ${source.key}: ${entry.steps?.length ?? 0} of ${source.steps.length} steps`,
    );
  }
}

/**
 * Готовое описание или постановка в очередь. `pending` — описание будет (идёт
 * или ждёт очереди); `failed` — недавно не удалось, до окна повтора не зовём.
 * Описаны не все шаги скилла — прежняя запись с `refreshing`, пока идёт новая.
 */
export function describeOrQueue(
  describer: Describer,
  cache: Cache,
  source: DescribeSource,
): DescribeEntry | RefreshingEntry | 'pending' | 'failed' {
  const entry = freshEntry(cache, source);
  if (entry) return entry;
  const stored = cache[source.key];
  const partial = sameText(stored, source) ? stored : undefined;
  const waiting = (): RefreshingEntry | 'pending' =>
    partial ? { ...partial, refreshing: true } : 'pending';
  const flightKey = `${describer.appData}|${source.key}|${source.hash}`;
  if (inFlight.has(flightKey)) return waiting();
  const now = describer.now ?? Date.now;
  const failed = failedAt.get(flightKey);
  if (failed !== undefined && now() - failed < RETRY_AFTER_MS) return partial ?? 'failed';
  inFlight.add(flightKey);
  queue.push(async () => {
    try {
      await describeOne(describer, source);
      failedAt.delete(flightKey);
    } catch (error) {
      // Просроченные неудачи — прочь: ключ несёт хэш текста, и каждая правка
      // текста с упавшим описанием иначе оставляла запись навсегда (F-220).
      const at = now();
      for (const [key, time] of failedAt) if (at - time >= RETRY_AFTER_MS) failedAt.delete(key);
      failedAt.set(flightKey, at);
      describer.onError?.(error, source.key);
    } finally {
      inFlight.delete(flightKey);
    }
  });
  pump();
  return waiting();
}
