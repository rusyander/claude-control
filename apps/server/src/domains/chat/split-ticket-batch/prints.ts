import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { fingerprintOf, fingerprintsIn } from './compose.ts';

/** Открытая задача трекера — то, что сверке нужно знать. */
export interface OpenTrackerIssue {
  key: string;
  summary: string;
  description: string;
}

/**
 * Отпечатки находок — в памяти ПАНЕЛИ, не в трекере (владелец 26.10.2026: хэш-
 * подобных id в Jira нет никогда). Ключ — задача трекера, значение — отпечатки
 * находок, которые ушли в неё задачей или комментарием. По ним следующая
 * публикация (и другое разделение того же проекта) узнаёт открытую задачу про
 * ту же находку, даже если её название с тех пор правили.
 *
 * Задачи, заведённые до 26.10.2026, несут строку `agentdeck-fp:` в описании —
 * её сверка по-прежнему читает (`printsOf`), но не пишет больше никогда.
 */
export interface TicketPrints {
  /** Отпечатки, которые панель помнит за этой задачей. */
  of(issueKey: string): ReadonlySet<string>;
  /** Запомнить: эти находки ушли в эту задачу (новой задачей или комментарием). */
  remember(issueKey: string, findingKeys: readonly string[]): void;
  /** Задачи, за которыми панель помнит хоть один из этих отпечатков. */
  issuesWith(prints: readonly string[]): string[];
}

/** Нет памяти (проверки без неё) — сверка только по старой строке описания. */
export const NO_PRINTS: TicketPrints = {
  of: () => new Set(),
  remember: () => undefined,
  issuesWith: () => [],
};

/** Отпечатки задачи для сверки: память панели плюс старая строка описания. */
export function printsOf(issue: OpenTrackerIssue, prints: TicketPrints): Set<string> {
  return new Set([...prints.of(issue.key), ...fingerprintsIn(issue.description)]);
}

type PrintsFile = Record<string, string[]>;

/** Файл памяти в каталоге данных панели; каталог — геттер: он меняется со сменой конфига. */
export const PRINTS_FILE = 'split-ticket-prints.json';

export function fileTicketPrints(appDataDir: () => string): TicketPrints {
  const path = () => join(appDataDir(), PRINTS_FILE);
  const read = (): PrintsFile => {
    try {
      const data = readJsonFile<PrintsFile>(path(), {});
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      // Битый файл — памяти нет, а не отказ публикации: сверка по названию остаётся.
      return {};
    }
  };
  return {
    of: (issueKey) => new Set(read()[issueKey] ?? []),
    remember: (issueKey, findingKeys) => {
      if (!issueKey || findingKeys.length === 0) return;
      const data = read();
      const next = new Set([...(data[issueKey] ?? []), ...findingKeys.map(fingerprintOf)]);
      if (next.size === (data[issueKey]?.length ?? 0)) return;
      data[issueKey] = [...next];
      mkdirSync(dirname(path()), { recursive: true });
      writeJsonFile(path(), data);
    },
    issuesWith: (wanted) => {
      if (wanted.length === 0) return [];
      const set = new Set(wanted);
      return Object.entries(read())
        .filter(([, prints]) => prints.some((print) => set.has(print)))
        .map(([issueKey]) => issueKey);
    },
  };
}
