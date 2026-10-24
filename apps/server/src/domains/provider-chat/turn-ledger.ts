import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io/safe-io.ts';

/**
 * Журнал идущих ходов чужих CLI — для сторожа разработки (`lib/dev-watch.mjs`).
 *
 * Ходы Claude сторож видит по `runs.json` и откладывает перезапуск до их конца.
 * Ход Codex/Qwen/Gemini живёт процессом сервера и в тот журнал не попадает —
 * правка исходника посреди такого хода перезапускала сервер и обрывала ответ
 * (F2). Здесь лежит ровно то, что читает сторож: ключ, папка и pid — pid
 * самого СЕРВЕРА: ход умирает вместе с ним, поэтому запись упавшего сервера
 * сторож по мёртвому pid не считает.
 */
export const PROVIDER_TURN_LEDGER = 'provider-runs.json';

export interface ProviderTurnEntry {
  /** `foreignChatKey` разговора. */
  key: string;
  /** Папка разговора — по ней сторож называет ход, которого не дождётся. */
  cwd: string;
  pid: number;
  startedAt: number;
}

/**
 * Отметить начало (`entry`) или конец (`undefined`) хода. Записи прошлых
 * серверов (чужой pid) выбрасываются: их ходы умерли с ними, а номер процесса
 * система могла уже выдать другому — и сторож ждал бы чужую программу.
 * Сбой записи хода не задевает.
 */
export function markProviderTurn(
  appDataDir: string,
  key: string,
  entry: Omit<ProviderTurnEntry, 'key' | 'pid'> | undefined,
  pid = process.pid,
): void {
  const file = join(appDataDir, PROVIDER_TURN_LEDGER);
  const kept = readEntries(file).filter((item) => item.pid === pid && item.key !== key);
  const next = entry ? [...kept, { key, pid, ...entry }] : kept;
  try {
    writeJsonFile(file, next);
  } catch {
    // Журнал — подсказка сторожу, не часть хода.
  }
}

function readEntries(file: string): ProviderTurnEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is ProviderTurnEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === 'string' && typeof item.pid === 'number';
}
