import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  apportionLimitShare,
  sumLimitShares,
  type LimitRun,
  type LimitSample,
  type LimitShare,
  type LimitWindowSample,
} from '@agentdeck/contracts/limit-share';
import { writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import type { RawEvent, RawLimitWindow } from '../chat-events.ts';

/**
 * Журнал прогонов для доли лимита подписки: интервал, токены и замеры загрузки
 * окон (первый и последний за прогон).
 *
 * Своим файлом в каталоге данных, как журнал понижений (`lowered-journal.ts`), и
 * по тем же причинам: дописывается на каждом завершении прогона, а битый файл
 * должен означать пустой журнал, а не панель без настроек. Замеров нет в
 * транскрипте — CLI шлёт их только в поток, — поэтому после перезапуска панели
 * их неоткуда взять, кроме этого файла.
 *
 * Пишутся ВСЕ прогоны с токенами, а не только звенья групп: загрузка окна общая
 * на подписку, и обычный чат, шедший рядом с группой, обязан забрать свою часть
 * прироста, иначе её целиком припишут группе.
 */

export interface LimitRunRecord extends LimitRun {
  chatId: string;
  sessionId?: string;
}

/** Недельное окно — самое длинное, что показывается; старше него запись не нужна. */
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;
/** Потолок на случай бурной недели: деление идёт по всем записям на каждый запрос. */
const LIMIT = 3000;

export function limitJournalPath(appDataDir: string): string {
  return join(appDataDir, 'limit-runs.json');
}

/**
 * Замер из `rate_limit_event`. Окно берётся, только если у него есть и загрузка,
 * и сброс: без сброса не отличить новое окно от падения загрузки. Ни одного окна —
 * замера нет (старый CLI).
 */
export function limitSampleOf(
  info: RawEvent['rate_limit_info'],
  at: number,
): LimitSample | undefined {
  const windows = info?.unifiedWindows;
  const fiveHour = windowOf(windows?.five_hour);
  const sevenDay = windowOf(windows?.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { at, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

function windowOf(raw: RawLimitWindow | undefined): LimitWindowSample | undefined {
  if (typeof raw?.utilization !== 'number' || !Number.isFinite(raw.utilization)) return undefined;
  if (typeof raw.resetsAt !== 'number' || !Number.isFinite(raw.resetsAt)) return undefined;
  return { utilization: raw.utilization, resetsAt: raw.resetsAt };
}

/** Прочитать журнал. Битый или отсутствующий файл — пустой журнал. */
export function readLimitRuns(appDataDir: string): LimitRunRecord[] {
  const path = limitJournalPath(appDataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

/** Дописать прогон; записи старше недели и сверх потолка уходят. */
export function appendLimitRun(appDataDir: string, record: LimitRunRecord, now = Date.now()): void {
  const fresh = readLimitRuns(appDataDir).filter((entry) => now - entry.endedAt <= KEEP_MS);
  writeJsonFile(limitJournalPath(appDataDir), [...fresh, record].slice(-LIMIT));
}

/**
 * Доля окон по разговорам: `sessionId` (или ключ чата, пока сессии нет) → сумма
 * долей его прогонов. Деление — `apportionLimitShare` по всем записям сразу.
 */
export function limitSharesByChat(records: readonly LimitRunRecord[]): Map<string, LimitShare> {
  const perRun = apportionLimitShare(records);
  const parts = new Map<string, LimitShare[]>();
  for (const record of records) {
    const share = perRun.get(record.id);
    if (!share) continue;
    const key = record.sessionId ?? record.chatId;
    const bucket = parts.get(key);
    if (bucket) bucket.push(share);
    else parts.set(key, [share]);
  }
  const result = new Map<string, LimitShare>();
  for (const [key, shares] of parts) {
    const sum = sumLimitShares(shares);
    if (sum) result.set(key, sum);
  }
  return result;
}

/**
 * Доли по разговорам с памятью по mtime файла: сводка чатов зовёт это на каждый
 * запрос списка, а деление — по всем записям недели.
 */
export function createLimitShareReader(appDataDir: string): () => Map<string, LimitShare> {
  let cached: { mtimeMs: number; size: number; shares: Map<string, LimitShare> } | undefined;
  return () => {
    const path = limitJournalPath(appDataDir);
    if (!existsSync(path)) return new Map();
    const { mtimeMs, size } = statSync(path);
    if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.shares;
    const shares = limitSharesByChat(readLimitRuns(appDataDir));
    cached = { mtimeMs, size, shares };
    return shares;
  };
}

function isRecord(value: unknown): value is LimitRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LimitRunRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.endedAt === 'number' &&
    typeof record.tokens === 'number' &&
    Array.isArray(record.samples)
  );
}
