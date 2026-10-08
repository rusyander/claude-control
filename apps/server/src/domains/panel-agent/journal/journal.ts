import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PanelActionJournalEntry } from '@agentdeck/contracts/panel-agent';

/**
 * След агента панели: каждое действие одной строкой в `<appData>/agent-actions.jsonl`.
 *
 * Зачем след вообще: действие агента не должно быть неотличимо от действия
 * человека. Через месяц на вопрос «кто добавил этот проект» ответ обязан
 * найтись — и с тем, кто подтвердил.
 *
 * Только дописывание, строка на действие: запись не переписывает файл целиком,
 * поэтому оборванная на полуслове панель теряет одну строку, а не весь след. В
 * строку идёт сводка из предпросмотра, но НИКОГДА вход целиком: в нём бывают
 * данные человека, а след читают глазами и переносят между машинами.
 */

const FILE = 'agent-actions.jsonl';

/** Сколько строк отдаём по умолчанию и максимум за один запрос. */
export const JOURNAL_DEFAULT_LIMIT = 50;
export const JOURNAL_MAX_LIMIT = 500;

export function agentJournalPath(appDataDir: string): string {
  return join(appDataDir, FILE);
}

/**
 * Дописать строку. Сбой записи не валит действие: оно уже выполнено или
 * отклонено, и отказать агенту из-за следа значило бы соврать ему об исходе.
 */
export function appendAgentJournal(appDataDir: string, entry: PanelActionJournalEntry): boolean {
  try {
    mkdirSync(appDataDir, { recursive: true });
    appendFileSync(agentJournalPath(appDataDir), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function isEntry(value: unknown): value is PanelActionJournalEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.at === 'string' &&
    typeof row.name === 'string' &&
    typeof row.outcome === 'string' &&
    typeof row.summary === 'string'
  );
}

/**
 * Последние записи, свежие первыми. Битая строка пропускается молча: одна
 * оборванная запись не должна прятать весь след.
 */
export function readAgentJournal(
  appDataDir: string,
  limit: number = JOURNAL_DEFAULT_LIMIT,
): PanelActionJournalEntry[] {
  const path = agentJournalPath(appDataDir);
  if (!existsSync(path)) return [];
  const capped = Math.max(1, Math.min(JOURNAL_MAX_LIMIT, Math.floor(limit)));
  const rows: PanelActionJournalEntry[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = lines.length - 1; index >= 0 && rows.length < capped; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) rows.push(parsed);
    } catch {
      // Оборванная строка — пропускаем.
    }
  }
  return rows;
}
