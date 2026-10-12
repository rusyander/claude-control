import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectTestAutomationFormat } from '@agentdeck/contracts';
import { cargoTestToJUnit, goTestJsonToJUnit } from './native-reports.ts';

/**
 * Отчёт прогона: файл или каталог, JUnit или родной вывод инструмента.
 *
 * Каталог (путь кончается разделителем) — так пишут Gradle и Maven, файл на
 * класс тестов. Его панель НЕ стирает перед прогоном: там может лежать чужое,
 * и стирать каталог сборки — не её дело. Вчерашнее отсекается по времени:
 * берутся только `*.xml`, записанные этим прогоном.
 */

/** Допуск часов файловой системы: отчёт, записанный в ту же секунду, — свежий. */
const CLOCK_SLACK_MS = 1000;

export const isReportDir = (report: string): boolean => /[\\/]$/.test(report);

/** Перед прогоном: прошлый файл отчёта — долой, каталог — на месте. */
export function clearReport(report: string): void {
  if (isReportDir(report)) return;
  // Прошлый отчёт — долой ДО запуска: иначе упавшая команда «вернула» бы
  // вчерашние результаты.
  rmSync(report, { force: true });
  mkdirSync(join(report, '..'), { recursive: true });
}

const fresh = (path: string, startedMs: number): boolean => {
  try {
    return statSync(path).mtimeMs >= startedMs - CLOCK_SLACK_MS;
  } catch {
    return false;
  }
};

export interface CollectedReport {
  /** JUnit XML: родной вывод уже переведён, файлы каталога сведены в один. */
  content: string;
  /** Сколько файлов отчёта легло (у каталога — сколько свежих `*.xml`). */
  files: number;
}

/** Тело одного JUnit-файла без пролога и внешней `<testsuites>`. */
const suitesOf = (xml: string): string =>
  xml
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<\/?testsuites\b[^>]*>/g, '')
    .trim();

/**
 * Отчёт ЭТОГО прогона или `undefined`: файла нет, он старше старта, в каталоге
 * нет ни одного свежего `*.xml`. Чтение без обхода вглубь: каталог отчётов у
 * Gradle и Maven плоский, а обход дерева сборки нашёл бы и чужие отчёты.
 */
export function collectReport(
  report: string,
  format: ProjectTestAutomationFormat,
  startedMs: number,
): CollectedReport | undefined {
  if (isReportDir(report)) {
    let names: string[];
    try {
      names = readdirSync(report);
    } catch {
      return undefined;
    }
    const files = names
      .filter((name) => name.toLowerCase().endsWith('.xml'))
      .map((name) => join(report, name))
      .filter((path) => fresh(path, startedMs))
      .sort();
    if (files.length === 0) return undefined;
    const body = files.map((path) => suitesOf(readFileSync(path, 'utf8'))).join('\n');
    return { content: `<testsuites>\n${body}\n</testsuites>\n`, files: files.length };
  }
  if (!fresh(report, startedMs)) return undefined;
  const raw = readFileSync(report, 'utf8');
  if (format === 'junit') return { content: raw, files: 1 };
  const content = format === 'go-test-json' ? goTestJsonToJUnit(raw) : cargoTestToJUnit(raw);
  // Перенаправление `> отчёт` создаёт файл и тогда, когда программы нет: в нём
  // пусто или «не является командой». Это не «ноль тестов», а отчёта нет.
  return content.includes('<testcase') ? { content, files: 1 } : undefined;
}

/**
 * Хвост файла отчёта — когда из него не вышло результатов. Родной вывод идёт в
 * файл целиком (`> отчёт 2>&1`), и без хвоста причина — «cargo не найден» —
 * не видна нигде: вывод команды пуст.
 */
export function reportTail(report: string, limit = 2000): string {
  if (isReportDir(report)) return '';
  try {
    return readFileSync(report, 'utf8').slice(-limit).trim();
  } catch {
    return '';
  }
}
