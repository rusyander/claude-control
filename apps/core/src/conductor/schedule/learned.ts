import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { toSlashes } from '../../lib/glob/glob.ts';
import { listDir } from '../../platform/safe-io/files.ts';

/**
 * Выученные длительности (02:65, 02:81): сколько шла единица той же области в прошлых задачах —
 * от `start` до `ready`/`close` по часам журнала. Область — репозиторий + верхний каталог первого
 * своего пути; нет образцов области — медиана репозитория. Задача, где человек менял модель или
 * CLI (`override.set`), в учёбу не идёт: её время меряет чужой выбор (02:95).
 */

export interface UnitSample {
  repoKey: string;
  area: string;
  ms: number;
}

export interface LearnedDurations {
  byArea: Record<string, number>;
  byRepo: Record<string, number>;
  samples: number;
  /** Журналы, которые не прочитались, — названы, не молча пропущены. */
  skipped: number;
}

export function areaOf(repoKey: string, ownedPaths: readonly string[]): string {
  const first = toSlashes(ownedPaths[0] ?? '');
  const top = first.split('/').find((s) => s !== '') ?? '';
  const literal = ['*', '?', '['].some((c) => top.includes(c)) ? '' : top;
  return `${repoKey}|${literal}`;
}

const END_STATES = new Set(['ready-to-publish', 'done']);

/** Образцы одного журнала: единица, дошедшая от старта до готовности; закрытая без готовности — нет. */
export function samplesOf(lines: readonly JournalLine[]): UnitSample[] {
  if (lines.some((l) => l.kind === 'override.set')) return [];
  const units = new Map<string, { repoKey: string; area: string; start?: number; end?: number }>();
  for (const l of lines) {
    if (l.kind === 'unit.created') {
      const d = l.data as JournalLine<'unit.created'>['data'];
      units.set(d.unitId, { repoKey: d.repoKey, area: areaOf(d.repoKey, d.ownedPaths) });
    } else if (l.kind === 'unit.transition') {
      const d = l.data as JournalLine<'unit.transition'>['data'];
      const u = units.get(d.unitId);
      if (!u) continue;
      if (d.to === 'running' && u.start === undefined) u.start = l.at;
      if (END_STATES.has(d.to) && u.start !== undefined && u.end === undefined) u.end = l.at;
    }
  }
  const out: UnitSample[] = [];
  for (const u of units.values()) {
    if (u.start === undefined || u.end === undefined || u.end < u.start) continue;
    out.push({ repoKey: u.repoKey, area: u.area, ms: u.end - u.start });
  }
  return out;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function learnFrom(samples: readonly UnitSample[], skipped = 0): LearnedDurations {
  const group = (key: (s: UnitSample) => string): Record<string, number> => {
    const by = new Map<string, number[]>();
    for (const s of samples) by.set(key(s), [...(by.get(key(s)) ?? []), s.ms]);
    return Object.fromEntries([...by].map(([k, v]) => [k, median(v)]));
  };
  return {
    byArea: group((s) => s.area),
    byRepo: group((s) => s.repoKey),
    samples: samples.length,
    skipped,
  };
}

export function learnedFor(
  learned: LearnedDurations,
  repoKey: string,
  ownedPaths: readonly string[],
): number | null {
  return learned.byArea[areaOf(repoKey, ownedPaths)] ?? learned.byRepo[repoKey] ?? null;
}

/**
 * Прочитать прошлые журналы задач (класс `durations.learned`): каталог задач не читается —
 * `unknown`, оценка `null`; один битый журнал — пропущен и сосчитан, остальные учат.
 */
export function readLearnedDurations(
  tasksDir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<Fact<LearnedDurations>> {
  return readFact('durations.learned', () => {
    const listed = listDir(tasksDir);
    if ('unknown' in listed) throw new Error(listed.unknown);
    if ('absent' in listed) return learnFrom([]);
    const samples: UnitSample[] = [];
    let skipped = 0;
    for (const taskId of listed.value) {
      if (!isUuidv7(taskId) || exclude.has(taskId)) continue;
      try {
        samples.push(...samplesOf(readJournalLines(join(tasksDir, taskId), taskId).lines));
      } catch {
        // Нечитаемый журнал не учит и не роняет учёбу остальных: он сосчитан в `skipped`.
        skipped += 1;
      }
    }
    return learnFrom(samples, skipped);
  });
}
