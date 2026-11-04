import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Уборка каталога слотов сервера моделей (`--slot-save-path`, L8). Сами кеши разговоров пишет и
 * читает ядро (`apps/core/src/platform/slot-cache.ts`, этап 10): смену разговора видит его звено,
 * не панель. Панели осталась уборка — при старте и раз в час: файл, оставшийся от прошлого запуска
 * или брошенного чата, иначе лежал бы до следующей записи ядра (её может не быть неделями), а
 * один такой файл — гигабайты.
 *
 * Уходят: файлы чужого запуска (`shape` не тот; сервер не поднят — по запуску не судим), старше
 * `MAX_SLOT_AGE_MS`, сверх `MAX_SLOT_FILES` и `MAX_SLOT_BYTES` (давние первыми), `.bin` без
 * описания (запись оборвалась на середине или файл оставлен замером) и нечитаемые описания.
 */

/** Сколько файлов держать: по одному на чат, самые давние уходят. */
export const MAX_SLOT_FILES = 6;
/** Сколько места занимать: файл — ~100 КБ на токен (замер 15.10), 131072 токена — ~13 ГБ. */
export const MAX_SLOT_BYTES = 32 * 1024 ** 3;
/** Старше этого кеш не держится: к чату, брошенному на трое суток, проще прочитать промпт заново. */
export const MAX_SLOT_AGE_MS = 3 * 24 * 60 * 60_000;

interface Meta {
  session: string;
  shape: string;
  savedAt: number;
}

/** Имя файла из номера разговора — так его называет и ядро: llama.cpp принимает только имя без пути. */
export function slotFileOf(session: string): string {
  return `${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}.bin`;
}

export interface SlotSweepInput {
  dir: string;
  /** Запуск сервера, с которого снят кеш; сервера нет — `undefined`. */
  shape: string | undefined;
  now: number;
  log?: (line: string) => void;
}

export function sweepSlotDir({ dir, shape, now, log = () => undefined }: SlotSweepInput): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const oldest = now - MAX_SLOT_AGE_MS;
  const described = new Set<string>();
  let entries: { session: string; bytes: number; savedAt: number; stale: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Meta;
      const bin = join(dir, slotFileOf(meta.session));
      const bytes = existsSync(bin) ? statSync(bin).size : 0;
      described.add(slotFileOf(meta.session));
      entries.push({
        session: meta.session,
        bytes,
        savedAt: meta.savedAt,
        stale:
          (shape !== undefined && meta.shape !== shape) || bytes === 0 || !(meta.savedAt >= oldest),
      });
    } catch {
      rmSync(join(dir, name), { force: true });
    }
  }
  const drop = (session: string): void => {
    const bin = slotFileOf(session);
    rmSync(join(dir, bin), { force: true });
    rmSync(join(dir, bin.replace(/\.bin$/, '.json')), { force: true });
    log(`slot dropped: ${session}`);
  };
  for (const name of names) {
    if (!name.endsWith('.bin') || described.has(name)) continue;
    rmSync(join(dir, name), { force: true });
    log(`slot dropped: ${name} (no meta)`);
  }
  for (const entry of entries.filter((item) => item.stale)) drop(entry.session);
  entries = entries.filter((item) => !item.stale).sort((a, b) => b.savedAt - a.savedAt);
  let total = 0;
  entries.forEach((entry, index) => {
    total += entry.bytes;
    if (index >= MAX_SLOT_FILES || total > MAX_SLOT_BYTES) drop(entry.session);
  });
}
