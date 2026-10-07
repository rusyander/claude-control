import type { SieveClass } from './catalog.ts';
import { LEARNED_TEXT_MAX, LEARNED_TEXT_MIN, type LearnedSieveRow } from './report.ts';

// ---------------------------------------------------------------- выученные сита

/**
 * `proposed` — модель группы вывела сито из треда ревьюера, в задания оно не идёт;
 * `active` — человек принял, и сито едет в задания звеньев (ревью сит, 28.09: текст
 * любого комментатора MR иначе становился постоянным заданием во всех проектах).
 */
export type LearnedSieveStatus = 'proposed' | 'active';

/**
 * Потолок хранилища выученных сит: больше — задание звена превращается в
 * простыню. Вытесняется давно не виденное непринятое; принятое — никогда (Ф4).
 */
export const LEARNED_SIEVES_MAX = 40;

/** Выученное сито в хранилище панели. */
export interface LearnedSieve {
  id: string;
  class: SieveClass;
  status: LearnedSieveStatus;
  scope: 'project' | 'global';
  /** Проект, где сито выучено (для `scope: 'project'`). */
  projectPath?: string;
  /**
   * Модель просила общее сито или тот же блокер всплыл в другом проекте — это
   * совет человеку, а не охват: общим сито делает только он.
   */
  suggestedScope?: 'global';
  trigger: string;
  check: string;
  /**
   * Области кода, где блокер находили (`areaOf` файла треда ревьюера). Проектное
   * сито идёт в задание, только когда дифф задел одну из них: иначе каждое
   * выученное сито ехало бы во все задачи проекта и тонуло в шуме. Нет поля —
   * хоть один тред был без файла, и сито применяется везде.
   */
  areas?: string[];
  /** Треды, из которых оно выучено, — доказательство, что блокер был. */
  sources: { thread: string; mr?: string; at: string }[];
  createdAt: string;
  lastSeenAt: string;
}

/** Счёт класса блокеров за месяц: ушло в MR и поймано панелью до MR. */
export interface SieveTallyCell {
  escaped: number;
  caught: number;
}

/** `YYYY-MM` → класс → счёт. */
export type SieveTally = Record<string, Partial<Record<SieveClass, SieveTallyCell>>>;

/** `GET /api/sieves`: выученные сита и счёт; встроенные — `BUILTIN_SIEVES`. */
export interface SievesView {
  learned: LearnedSieve[];
  tally: SieveTally;
  /**
   * Новые сита не записаны: хранилище полно, и все сита в нём приняты
   * человеком (Ф4) — принятое не вытесняется никогда. Сколько отказано и когда
   * последний раз; снимается, когда человек убирает сито.
   */
  refused?: { count: number; at: string };
}

/** Слова для сравнения: нижний регистр, буквы и цифры, без коротких связок. */
function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

/** Похожесть двух проверок по словам (Жаккар). */
export function checkSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}

/** С этой похожести проверка того же класса — то же сито, а не новое. */
export const SAME_SIEVE_SIMILARITY = 0.5;

/** Почему выученное сито не принято — код для журнала и теста. */
export type LearnedRejection = 'unknown-thread' | 'too-short' | 'too-long' | 'store-full';

/**
 * Принять выученное сито. Главное условие — тред: он должен быть среди тех,
 * что панель САМА переслала группе (`relayed`), — иначе сито выдумано. Только
 * точное совпадение: задание просит ссылку «ровно как в списке», а совпадение по
 * хвосту пропускало `"2"` к `…#note_42` и чужой адрес с тем же якорем (ревью сит).
 */
export function acceptLearned(
  row: LearnedSieveRow,
  relayed: readonly string[],
): LearnedRejection | undefined {
  if (!relayed.includes(row.thread.trim())) {
    return 'unknown-thread';
  }
  if (row.check.length < LEARNED_TEXT_MIN || row.trigger.length < LEARNED_TEXT_MIN / 2) {
    return 'too-short';
  }
  if (row.check.length > LEARNED_TEXT_MAX) return 'too-long';
  return undefined;
}

/**
 * Область файла — первые два каталога пути (`apps/server`, `src/api`): уже
 * пакета, чтобы не звать сито на чужой код, и шире каталога, чтобы тот же класс
 * блокера в соседнем модуле не проходил мимо.
 */
export function areaOf(path: string): string {
  const dirs = path.replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean);
  return dirs.slice(0, 2).join('/');
}

/** Применимо ли выученное сито к диффу: общее и без областей — всегда. */
export function learnedAppliesTo(
  sieve: Pick<LearnedSieve, 'scope' | 'areas'>,
  touched: readonly string[],
): boolean {
  if (sieve.scope === 'global' || !sieve.areas?.length) return true;
  const areas = new Set(sieve.areas);
  return touched.some((path) => areas.has(areaOf(path)));
}
