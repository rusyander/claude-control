import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DlpJournalEntry } from '@claude-control/contracts';

/**
 * Журнал срабатываний: что и когда было заменено или отклонено.
 *
 * Значений в журнале нет и не будет — ни исходных, ни замаскированных. Пишутся
 * только правило, метка и счётчик: журнал защиты данных, складывающий рядом сами
 * данные, был бы главной дырой в этой защите.
 *
 * Формат — JSONL рядом с состоянием панели: строка на запись, обрыв портит одну
 * строку, а не файл.
 */

const FILE = 'dlp-journal.jsonl';
/** Потолок файла: дальше начало отбрасывается. Журнал — лента, не архив. */
const MAX_BYTES = 2_000_000;
const KEEP_LINES = 500;

function journalPath(appDataDir: string): string {
  return join(appDataDir, FILE);
}

export function appendJournal(appDataDir: string, entry: DlpJournalEntry): void {
  try {
    mkdirSync(appDataDir, { recursive: true });
    const path = journalPath(appDataDir);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    trimJournal(path);
  } catch {
    // Журнал — вспомогательная вещь: его отказ не должен ронять сам прокси.
  }
}

function trimJournal(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.length <= MAX_BYTES) return;
    const lines = raw.split('\n').filter(Boolean).slice(-KEEP_LINES);
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // см. выше
  }
}

/** Последние записи, свежие сверху. Битая строка пропускается, а не роняет чтение. */
export function readJournal(appDataDir: string, limit = 200): DlpJournalEntry[] {
  const path = journalPath(appDataDir);
  if (!existsSync(path)) return [];

  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-limit);
    const entries: DlpJournalEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as DlpJournalEntry);
      } catch {
        continue;
      }
    }
    return entries.reverse();
  } catch {
    return [];
  }
}

export function clearJournal(appDataDir: string): void {
  const path = journalPath(appDataDir);
  if (existsSync(path)) writeFileSync(path, '', 'utf8');
}
