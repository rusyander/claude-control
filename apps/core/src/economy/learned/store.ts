import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { readJournalLines } from '../../journal/read-lines.ts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { learnFrom, samplesOfJournal } from './derive.ts';
import type { JournalSamples, LearnedCache, LearnedTable } from './learned.types.ts';

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

/** Версия кэша: другая (старая) — кэш пересобирается из журналов, вклады старой формы не читаются. */
const LEARNED_CACHE_VERSION = 2;

function readCache(path: string): LearnedCache {
  const empty: LearnedCache = { version: LEARNED_CACHE_VERSION, journals: {} };
  const read = readBytesSync(path);
  if (!('value' in read)) return empty;
  try {
    const parsed = JSON.parse(read.value.toString('utf8')) as Partial<LearnedCache>;
    if (
      parsed.version !== LEARNED_CACHE_VERSION ||
      typeof parsed.journals !== 'object' ||
      parsed.journals === null
    )
      return empty;
    return { version: LEARNED_CACHE_VERSION, journals: parsed.journals };
  } catch {
    // Битый кэш — пересборка из журналов, а не отказ: истина в журналах.
    return empty;
  }
}

export interface LearnedPaths {
  tasksDir: string;
  cacheFile: string;
}

export function readLearned(paths: LearnedPaths): Promise<Fact<LearnedTable>> {
  return readFact('durations.learned', () => {
    const listed = listDir(paths.tasksDir);
    if ('unknown' in listed) throw new Error(listed.unknown);
    const cache = readCache(paths.cacheFile);
    const ids = 'absent' in listed ? [] : listed.value.filter(isUuidv7);
    const out: JournalSamples[] = [];
    const kept: Record<string, JournalSamples> = {};
    let skipped = 0;
    let changed = false;
    for (const taskId of ids) {
      const cached = cache.journals[taskId];
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
    if (changed)
      writeFileAtomic(
        paths.cacheFile,
        `${JSON.stringify({ version: LEARNED_CACHE_VERSION, journals: kept } satisfies LearnedCache)}\n`,
      );
    return learnFrom(out, skipped);
  });
}
