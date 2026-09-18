import { join } from 'node:path';
import type { PlatformSummarizedLink, PlatformSummarizedReport } from '@agentdeck/contracts';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io.ts';

/**
 * Журнал сжатий истории контуром (`context-managed`).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, а не журнал запросов шлюза. Тот живёт в памяти и
 * ограничен по длине: подпись «контур сжал историю» под ответом гасла бы после
 * перезапуска панели или сотни запросов — ровно тогда, когда человек
 * перечитывает старый разговор и не понимает, почему модель «забыла» начало.
 * Сжатие случается редко, поэтому запись на диск на каждый случай ничего не стоит.
 *
 * ЧЕМ ПРИВЯЗАНО К ОТВЕТУ. Двумя точными ключами и ни одним приблизительным:
 * - `messageId` — id сообщения, который шлюз сам выдал клиенту Anthropic; Claude
 *   Code пишет его в транскрипт, и лента находит по нему ТОТ ответ;
 * - `runTag` — метка прогона чужого CLI в адресе шлюза, выданная только ему.
 * Окно времени («сжатие было, пока шёл прогон») отвергнуто: два чата через один
 * контур в одно время получили бы чужую подпись. Запрос без обоих ключей
 * (терминал, файл настроек CLI) виден только в разделе «Контур».
 */

export interface SummarizedRecord {
  at: string;
  platformId: string;
  path: string;
  messageId?: string;
  runTag?: string;
}

const FILE = 'platform-summarized.json';
/** Сколько последних случаев помним. Старше — подпись у ответа гаснет. */
export const SUMMARIZED_CAP = 500;
/** Сколько случаев показывает карточка раздела. */
const RECENT = 10;

/** Кэш на процесс: лента читает журнал на каждую страницу переписки. */
const cache = new Map<string, SummarizedRecord[]>();

function fileOf(appDataDir: string): string {
  return join(appDataDir, FILE);
}

function isRecord(value: unknown): value is SummarizedRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === 'string' && typeof record.platformId === 'string';
}

export function readSummarized(appDataDir: string): SummarizedRecord[] {
  const cached = cache.get(appDataDir);
  if (cached) return cached;
  let records: SummarizedRecord[];
  try {
    const raw = readJsonFile<unknown>(fileOf(appDataDir), []);
    records = Array.isArray(raw) ? raw.filter(isRecord) : [];
  } catch {
    // Испорченный файл — не повод ронять ленту: подписи начнутся с чистого листа.
    records = [];
  }
  cache.set(appDataDir, records);
  return records;
}

/** Записать случай сжатия. Сбой записи не ломает ответ — он уже ушёл клиенту. */
export function noteSummarized(appDataDir: string, record: SummarizedRecord): void {
  const next = [...readSummarized(appDataDir), record].slice(-SUMMARIZED_CAP);
  cache.set(appDataDir, next);
  try {
    writeJsonFile(fileOf(appDataDir), next, { preserveForm: false });
  } catch {
    // В памяти случай остался: до перезапуска подпись видна.
  }
}

/** Id сообщений, перед которыми контур сжал историю, — для ленты Claude. */
export function summarizedMessageIds(appDataDir: string): Set<string> {
  const ids = new Set<string>();
  for (const record of readSummarized(appDataDir)) {
    if (record.messageId) ids.add(record.messageId);
  }
  return ids;
}

/** Было ли сжатие в прогоне с этой меткой — для ответа чата чужого CLI. */
export function summarizedInRun(appDataDir: string, runTag: string): boolean {
  if (!runTag) return false;
  return readSummarized(appDataDir).some((record) => record.runTag === runTag);
}

function linkOf(record: SummarizedRecord): PlatformSummarizedLink {
  if (record.messageId) return 'message';
  if (record.runTag) return 'run';
  return 'none';
}

/** Сводка для карточки раздела «Контур». */
export function summarizedReport(appDataDir: string): PlatformSummarizedReport {
  const records = readSummarized(appDataDir);
  return {
    total: records.length,
    recent: records
      .slice(-RECENT)
      .reverse()
      .map((record) => ({
        at: record.at,
        platformId: record.platformId,
        path: record.path,
        link: linkOf(record),
      })),
  };
}

/** Для тестов: забыть кэш процесса. */
export function resetSummarizedCache(): void {
  cache.clear();
}
