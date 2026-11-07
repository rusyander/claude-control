import { dirname, join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { readJournalLines } from '../../journal/read-lines.ts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { defaultRoleOf } from '../tier-ladder.ts';
import { learnFrom, samplesOfJournal } from './derive.ts';
import type { JournalSamples, LearnedCache, LearnedReset, LearnedTable } from './learned.types.ts';

/**
 * Выученное с диска: законченные журналы `<home>/tasks/*`, кэш их вкладов в
 * `<home>/cache/learned.json`. Кэш — только ускорение: битый, чужой версии или удалённый —
 * пересобирается из журналов, истина остаётся в журналах. Незаконченная задача в кэш не
 * пишется (её шаги ещё идут). Нечитаемый журнал не роняет учёбу остальных: сосчитан в `skipped`.
 * Каталог задач не читается — `unknown` (класс чтения прошлых журналов `durations.learned`).
 */

export function learnedCachePath(homeRoot: string): string {
  return join(homeRoot, 'cache', 'learned.json');
}

/**
 * Сбросы ключей человеком (P140) — своё долговечное хранилище ядра `<home>/learned-resets.json`,
 * НЕ кэш: кэш удаляют, его версию поднимают, и тогда снятый человеком подъём молча вернулся бы
 * (журналы задач сброса не несут — он команда ядра, не строка задачи).
 */
export function learnedResetsPath(homeRoot: string): string {
  return join(homeRoot, 'learned-resets.json');
}

/** Пути выученного дома ядра по каталогу его задач (кэш и сбросы лежат в доме, рядом с ним). */
export function learnedPathsFor(tasksDir: string): LearnedPaths {
  const home = dirname(tasksDir);
  return { tasksDir, cacheFile: learnedCachePath(home), resetsFile: learnedResetsPath(home) };
}

const RESETS_VERSION = 1;

interface ResetsFile {
  version: typeof RESETS_VERSION;
  resets: Record<string, LearnedReset>;
}

const isReset = (v: unknown): v is LearnedReset =>
  isRecord(v) && typeof v.at === 'number' && typeof v.cmdId === 'string';

/**
 * Сбросы с диска: файла нет — сбросов не было. Битый или чужой формы — ошибка чтения, не «нет
 * сбросов»: иначе снятый человеком подъём вернулся бы сам (P140), а выученное станет `unknown`.
 */
function readResets(path: string): Record<string, LearnedReset> {
  const read = readBytesSync(path);
  if ('absent' in read) return {};
  if (!('value' in read)) throw new Error(`learned resets unreadable: ${read.unknown}`);
  const parsed: unknown = JSON.parse(read.value.toString('utf8'));
  if (!isRecord(parsed) || parsed.version !== RESETS_VERSION || !isRecord(parsed.resets))
    throw new Error(`learned resets ${path}: unknown shape`);
  const out: Record<string, LearnedReset> = {};
  for (const [key, reset] of Object.entries(parsed.resets)) {
    if (!isReset(reset)) throw new Error(`learned resets ${path}: bad row ${key}`);
    out[key] = { at: reset.at, cmdId: reset.cmdId };
  }
  return out;
}

const writeResets = (path: string, resets: Record<string, LearnedReset>): void =>
  writeFileAtomic(
    path,
    `${JSON.stringify({ version: RESETS_VERSION, resets } satisfies ResetsFile)}\n`,
  );

/**
 * Версия кэша: v2 поднимается (`upcastLearnedCache`), другая (старее) — кэш пересобирается из
 * журналов, вклады старой формы не читаются.
 */
const LEARNED_CACHE_VERSION = 3;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Кэш v2 → v3 (этап 11): ключ шага получает роль вида шага (`defaultRoleOf`), проба первого
 * прохода — `null` (v2 её не снимал), сбросов нет; строки и числа вклада те же. v3 — как есть.
 * Чужая форма — `null` (кэш пересобирается из журналов).
 */
export function upcastLearnedCache(parsed: unknown): LearnedCache | null {
  if (!isRecord(parsed) || !isRecord(parsed.journals)) return null;
  if (parsed.version === LEARNED_CACHE_VERSION)
    return {
      version: LEARNED_CACHE_VERSION,
      journals: parsed.journals as LearnedCache['journals'],
      resets: isRecord(parsed.resets) ? (parsed.resets as LearnedCache['resets']) : {},
    };
  if (parsed.version !== 2) return null;
  const journals: LearnedCache['journals'] = {};
  for (const [taskId, j] of Object.entries(parsed.journals as Record<string, JournalSamples>)) {
    journals[taskId] = {
      ...j,
      steps: j.steps.map((s) => {
        const role = s.key.role ?? defaultRoleOf(s.key.stepKind);
        return { ...s, key: { ...s.key, ...(role ? { role } : {}) }, firstPass: null };
      }),
    };
  }
  return { version: LEARNED_CACHE_VERSION, journals, resets: {} };
}

/** Кэш с диска; `raised` — прочитан кэш старой версии (v2): его стоит переписать как v3. */
function readCacheOf(path: string): { cache: LearnedCache; raised: boolean } {
  const empty: LearnedCache = { version: LEARNED_CACHE_VERSION, journals: {}, resets: {} };
  const read = readBytesSync(path);
  if (!('value' in read)) return { cache: empty, raised: false };
  try {
    const parsed: unknown = JSON.parse(read.value.toString('utf8'));
    const cache = upcastLearnedCache(parsed);
    if (!cache) return { cache: empty, raised: false };
    return { cache, raised: isRecord(parsed) && parsed.version !== LEARNED_CACHE_VERSION };
  } catch {
    // Битый кэш — пересборка из журналов, а не отказ: истина в журналах.
    return { cache: empty, raised: false };
  }
}

const writeCache = (path: string, cache: LearnedCache): void =>
  writeFileAtomic(path, `${JSON.stringify(cache satisfies LearnedCache)}\n`);

/**
 * Сброс ключа обучения человеком (`learned-reset`, P140): пробы ключа до `at` больше не считаются,
 * подъём снят целиком. Хранится в долговечном файле сбросов (`learnedResetsPath`), не в кэше;
 * тот же ключ сбрасывается снова поверх прежнего.
 */
export function resetLearnedKey(resetsFile: string, key: string, reset: LearnedReset): void {
  writeResets(resetsFile, { ...readResets(resetsFile), [key]: reset });
}

export interface LearnedPaths {
  tasksDir: string;
  cacheFile: string;
  /** Долговечные сбросы человека (`learnedResetsPath`) — переживают удаление и версию кэша. */
  resetsFile: string;
}

/** Вклад журнала заново; не закончен или не прочёлся — `null`. */
function rederive(paths: LearnedPaths, taskId: string): JournalSamples | null {
  try {
    return samplesOfJournal(taskId, readJournalLines(join(paths.tasksDir, taskId), taskId).lines);
  } catch {
    return null;
  }
}

export function readLearned(paths: LearnedPaths): Promise<Fact<LearnedTable>> {
  return readFact('durations.learned', () => {
    const listed = listDir(paths.tasksDir);
    if ('unknown' in listed) throw new Error(listed.unknown);
    const { cache, raised } = readCacheOf(paths.cacheFile);
    // Сбросы: долговечный файл; сбросы, которые прежняя версия держала в кэше, переносятся в
    // него один раз — дальше кэш их не несёт, и его удаление сброс не снимает.
    const durable = readResets(paths.resetsFile);
    // Строка чужой формы не переносится: в долговечном файле она уронила бы каждое чтение.
    const carried = Object.entries(cache.resets).filter(
      ([key, reset]) => !(key in durable) && isReset(reset),
    );
    const resets = { ...Object.fromEntries(carried), ...durable };
    if (carried.length > 0) writeResets(paths.resetsFile, resets);
    const ids = 'absent' in listed ? [] : listed.value.filter(isUuidv7);
    const out: JournalSamples[] = [];
    const kept: Record<string, JournalSamples> = {};
    let skipped = 0;
    let changed = raised;
    for (const taskId of ids) {
      const cached = cache.journals[taskId];
      // Вклад, записанный до длительностей сеансов (`sessionMs`), пересобирается из журнала:
      // иначе старый дом навсегда остался бы без медианы сеанса (ожидание места «не оценено»).
      // Журнал не прочёлся — остаётся прежний вклад как есть (без образцов сеансов), а не пропадает.
      const refreshed = cached && !Array.isArray(cached.sessionMs) ? rederive(paths, taskId) : null;
      if (refreshed) {
        out.push(refreshed);
        kept[taskId] = refreshed;
        changed = true;
        continue;
      }
      if (cached) {
        out.push(cached);
        kept[taskId] = cached;
        continue;
      }
      try {
        const samples = samplesOfJournal(
          taskId,
          readJournalLines(join(paths.tasksDir, taskId), taskId).lines,
        );
        if (!samples) continue;
        out.push(samples);
        kept[taskId] = samples;
        changed = true;
      } catch {
        skipped += 1;
      }
    }
    // Задача, ушедшая из каталога, уходит и из кэша: кэш не учит тем, чего уже нет.
    if (Object.keys(cache.journals).some((id) => !(id in kept))) changed = true;
    if (changed || carried.length > 0)
      writeCache(paths.cacheFile, { version: LEARNED_CACHE_VERSION, journals: kept, resets: {} });
    return learnFrom(out, skipped, resets);
  });
}
