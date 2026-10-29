import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Свой каталог покрытия на прогон набора. Vitest держит сырые карты в `<reportsDirectory>/.tmp`
 * и в начале прогона стирает каталог целиком: два `pnpm core:test` разом (несколько агентов в
 * одной копии) стирали друг другу `.tmp`, и первый падал ENOENT на `coverage-<n>.json`.
 * Каталог `coverage/run-<pid>` принадлежит одному процессу vitest — чужой прогон его не трогает.
 */
export const RUN_PREFIX = 'run-';

export function coverageRunDir(coverageRoot: string, pid: number = process.pid): string {
  return join(coverageRoot, `${RUN_PREFIX}${pid}`);
}

/** Жив ли процесс: EPERM — процесс есть, но чужой; любая другая ошибка — процесса нет. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Время готовой карты прогона или 0, если прогон не дописал её (упал, ещё идёт). */
function mapTime(dir: string): number {
  const map = join(dir, 'coverage-final.json');
  return existsSync(map) ? statSync(map).mtimeMs : 0;
}

/**
 * Каталоги завершённых прогонов убираются, иначе html-отчёт копился бы на каждый прогон.
 * Живой прогон не трогается никогда; из мёртвых остаётся самый свежий с готовой картой —
 * его читает `tools/core-coverage-merge.mjs` без аргументов. Возвращает убранные каталоги.
 */
export function pruneFinishedRuns(
  coverageRoot: string,
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  if (!existsSync(coverageRoot)) return [];
  const finished = readdirSync(coverageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX))
    .map((entry) => ({
      dir: join(coverageRoot, entry.name),
      pid: Number(entry.name.slice(RUN_PREFIX.length)),
    }))
    .filter((run) => Number.isInteger(run.pid) && run.pid > 0 && !alive(run.pid))
    .map((run) => ({ dir: run.dir, time: mapTime(run.dir) }))
    .sort((a, b) => b.time - a.time);
  const keep = finished[0]?.time ? finished[0].dir : undefined;
  const removed: string[] = [];
  for (const run of finished) {
    if (run.dir === keep) continue;
    // Два прогона могут убирать один и тот же мёртвый каталог разом — гонка безвредна.
    rmSync(run.dir, { recursive: true, force: true, maxRetries: 3 });
    removed.push(run.dir);
  }
  return removed;
}
