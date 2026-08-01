import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Analytics } from '@claude-control/contracts';
import { buildResult } from './report.ts';
import { scanFile } from './scan-file.ts';
import { emptyTotals } from './totals.ts';
import type { Accumulator, ScanOptions } from './types.ts';

/** Обход транскриптов за период и сборка отчёта. */
export async function scanAnalytics(
  projectsDir: string,
  options: ScanOptions,
): Promise<Omit<Analytics, 'runningAgents' | 'topSkills'>> {
  const startedAt = Date.now();
  // days из запроса может прийти мусором (`?days=abc` → NaN). Без защиты since
  // становится NaN, фильтры по времени молча пропускают всё, а сборка отчёта
  // падает на `new Date(NaN).toISOString()` — маршрут отвечает 500. Непонятный
  // ввод трактуем как период по умолчанию.
  const days = Number.isFinite(options.days) ? options.days : 30;
  const since =
    options.since !== undefined && Number.isFinite(options.since)
      ? options.since
      : Date.now() - days * 24 * 60 * 60 * 1000;

  const accumulator: Accumulator = {
    overall: emptyTotals(),
    cost: 0,
    byModel: new Map(),
    byDay: new Map(),
    byProject: new Map(),
    byHour: new Map(),
    sessions: new Map(),
    tools: new Map(),
  };

  const until =
    options.until !== undefined && Number.isFinite(options.until) ? options.until : Date.now();

  const files = collectTranscripts(projectsDir, since);
  for (const file of files) await scanFile(file, since, until, accumulator, options);

  return buildResult(accumulator, options, files.length, Date.now() - startedAt, since, until);
}

/** Собирает пути транскриптов, отсекая старые по времени изменения файла. */
function collectTranscripts(
  projectsDir: string,
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(projectsDir)) return [];
  const result: Array<{ path: string; mtimeMs: number }> = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(projectsDir, projectEntry.name);

    for (const fileEntry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      const filePath = join(projectPath, fileEntry.name);
      const stats = statSync(filePath);
      // Файл, не менявшийся с начала периода, точно не содержит свежих записей.
      if (stats.mtimeMs < since) continue;
      result.push({ path: filePath, mtimeMs: stats.mtimeMs });
    }
  }

  return result;
}
