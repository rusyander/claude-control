import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  newestLoopbackCore,
  procsFileSchema,
  verifyCoreEntry,
  type CoreEntryCheckDeps,
  type ProcEntry,
} from '@agentdeck/contracts/core/procs';

/**
 * Где ядро и чем к нему стучаться (07 §Phases): панель находит ядро по `<дом ядра>/procs.json`
 * и говорит токеном ядра `<дом ядра>/token` по HTTP на loopback. Ни строки не пишет: перезапуск
 * панели — это только новое чтение этих двух файлов (P23, F12).
 *
 * Строка файла — не доказательство (core-s9 F10, F-19): прежде прокладка верила любому адресу
 * из файла, и bearer ядра уходил тому, кто вписал свою строку. Теперь строка разбирается схемой
 * контрактов, берётся только loopback-адрес с портом строки, а перед отправкой токена
 * `verifyCoreEntry` (та же функция, что у мостов ядра) сверяет: порт слушает pid строки, и этот
 * pid жив с тем же стартом. Не сверилось — токен не уходит никуда.
 *
 * Читается на каждом запросе, а не при старте: ядро могло перезапуститься на другом порте.
 * Дом ядра (`coreHomeOf`) — один на панель, в `lib/hop-recorder.mjs`: сторож, записывающий
 * звенья, и прокладка обязаны смотреть в один и тот же дом.
 * Кода ядра здесь нет — граница панель/ядро держится правилом depcruise.
 */

export interface CoreLocation {
  url: string;
  token: string;
  entry: ProcEntry;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Строка ядра из `procs.json` и токен; иначе — чего не хватило (файла, строки, токена). */
export function locateCore(home: string): CoreLocation | { missing: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, 'procs.json'), 'utf8'));
  } catch (error) {
    return { missing: `procs.json: ${reasonOf(error)}` };
  }
  const parsed = procsFileSchema.safeParse(raw);
  if (!parsed.success) return { missing: 'procs.json: not a procs file' };
  // Несколько сборок разом (P83) — последняя запущенная среди loopback-строк; выбор — дело надзора.
  const entry = newestLoopbackCore(parsed.data.cores);
  if (!entry) return { missing: 'no loopback core in procs.json' };
  let token: string;
  try {
    token = readFileSync(join(home, 'token'), 'utf8').trim();
  } catch (error) {
    return { missing: `token: ${reasonOf(error)}` };
  }
  if (!token) return { missing: 'token: empty' };
  return { url: entry.url.replace(/\/+$/, ''), token, entry };
}

/** Сверка личности строки перед bearer (F-19): `unknown` — токен не отправляется. */
export function verifyCore(core: CoreLocation, deps: CoreEntryCheckDeps): Promise<Fact<true>> {
  return verifyCoreEntry(core.entry, deps);
}

export const FORWARDED_PEER_HEADER = 'x-agentdeck-peer-pid';

export interface CoreForward {
  method: 'GET' | 'POST';
  /** Путь API ядра с запросом (`/v1/nonce?page=…`). */
  path: string;
  body?: unknown;
  /**
   * pid процесса, приславшего запрос панели. Ставится ТОЛЬКО прокладкой, по таблице TCP;
   * заголовок клиента с тем же именем не пробрасывается никогда. 0 — пира узнать не вышло:
   * ядро сочтёт пересылку непроверенной и примет только подпись устройства.
   */
  peerPid?: number;
  /** Возобновление потока событий: последний полученный номер строки (SSE). */
  lastEventId?: string;
  signal?: AbortSignal;
}

/**
 * Запрос к ядру — только к уже сверенной строке. Ответ отдаётся как есть, потоком: прокладка
 * тела не копит (поток событий задачи живёт часами), разбор — забота вызывающего.
 */
export function forwardToCore(core: CoreLocation, call: CoreForward): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${core.token}` };
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.peerPid !== undefined) headers[FORWARDED_PEER_HEADER] = String(call.peerPid);
  if (call.lastEventId !== undefined) headers['last-event-id'] = call.lastEventId;
  return fetch(`${core.url}${call.path}`, {
    method: call.method,
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    ...(call.signal ? { signal: call.signal } : {}),
  });
}
