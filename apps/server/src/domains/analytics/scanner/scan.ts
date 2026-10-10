import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Analytics } from '@agentdeck/contracts';
import { buildResult } from './report.ts';
import { scanFile } from './scan-file.ts';
import { collectForeignFiles, entriesOf } from './foreign.ts';
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
    sessionTools: new Map(),
    sessionTitles: new Map(),
    unpriced: new Set(),
  };

  const until =
    options.until !== undefined && Number.isFinite(options.until) ? options.until : Date.now();

  const source = options.source;
  const files = source
    ? collectForeignFiles(source, since)
    : collectTranscripts(projectsDir, since);
  const entries = source ? entriesOf(source) : undefined;
  for (const file of files) await scanFile(file, since, until, accumulator, options, entries);

  return buildResult(accumulator, options, files.length, Date.now() - startedAt, since, until);
}

/**
 * Собирает пути транскриптов, отсекая старые по времени изменения файла.
 * Субагенты пишут свой транскрипт отдельно — `<проект>/<сессия>/subagents/
 * agent-*.jsonl` — и тратят те же токены подписки: без них аналитика
 * занижала расход сессии ровно на работу её агентов (решение 10.10). Записи
 * субагента несут `sessionId` родителя и ложатся в его сессию.
 */
function collectTranscripts(
  projectsDir: string,
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(projectsDir)) return [];
  const result: Array<{ path: string; mtimeMs: number }> = [];
  const take = (dir: string): void => {
    for (const fileEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = join(dir, fileEntry.name);
      const stats = statSync(filePath);
      // Файл, не менявшийся с начала периода, точно не содержит свежих записей.
      if (stats.mtimeMs < since) continue;
      result.push({ path: filePath, mtimeMs: stats.mtimeMs });
    }
  };

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(projectsDir, projectEntry.name);
    take(projectPath);
    for (const sessionEntry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const subagents = join(projectPath, sessionEntry.name, 'subagents');
      if (existsSync(subagents)) take(subagents);
    }
  }

  return result;
}
