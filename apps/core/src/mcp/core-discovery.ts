import { dirname } from 'node:path';
import {
  verifyCoreEntry,
  type CoreEntryCheckDeps,
  type ProcEntry,
} from '@agentdeck/contracts/core/procs';
import { readProcs } from '../platform/procs-file.ts';
import { readTcpTable } from '../platform/tcp-table.ts';
import { createLivenessProbe } from '../platform/process-identity.ts';
import { hasValue } from '../platform/os-kind.ts';
import { LOOPBACK } from '../platform/ports.ts';
import { samePath } from '../platform/paths.ts';

/**
 * Где мост ищет перезапущенное ядро (01 §Sessions at core death, P83): `<core home>/procs.json`.
 * Мост несёт туда bearer сессии и верит ответу `permit` — поэтому адрес из файла принимается
 * ТОЛЬКО когда это сам ядро этого дома (core-s2 F-19):
 * - адрес ровно `http://127.0.0.1:<port>` строки (ядро слушает только loopback) — никакого
 *   другого хоста, схемы, учётки или пути;
 * - строка названа домом, в котором лежит сам файл;
 * - порт слушает процесс с номером строки, и старт этого процесса совпадает с `pidStart`
 *   (порт, занятый чужим процессом после смерти ядра, — не ядро).
 * Не проверилось или ОС не ответила — адреса нет (мост ждёт дальше), а не «поверим».
 */

/** Как спросить ОС о личности ядра — те же зависимости, что у проверки платформы. */
export type CoreVerifyDeps = CoreEntryCheckDeps;

export const OS_VERIFY: CoreVerifyDeps = {
  tcp: () => readTcpTable(),
  // Без кэша снимка: мост спрашивает редко (подтверждённое кэшируется ниже), ответ должен быть свежим.
  isAlive: (id) => createLivenessProbe(undefined, 0).isAlive(id),
};

/** `http://127.0.0.1:<port>` строки или `null`, если адрес строки — что-то иное. */
export function loopbackUrl(entry: Pick<ProcEntry, 'url' | 'port'>): string | null {
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return null;
  }
  const exact =
    url.protocol === 'http:' &&
    url.hostname === LOOPBACK &&
    url.username === '' &&
    url.password === '' &&
    url.port === String(entry.port) &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '';
  return exact ? `http://${LOOPBACK}:${entry.port}` : null;
}

export type CoreCheck = (entry: ProcEntry, procsPath: string) => Promise<string | null>;

/**
 * Проверка строки procs.json; подтверждённая строка (та же загрузка, номер, старт, порт)
 * повторно ОС не спрашивает — мост зовёт поиск на каждом шаге ожидания.
 */
export function coreCheck(deps: CoreVerifyDeps = OS_VERIFY): CoreCheck {
  const confirmed = new Set<string>();
  return async (entry, procsPath) => {
    const url = loopbackUrl(entry);
    if (!url || !samePath(entry.home, dirname(procsPath))) return null;
    const key = `${entry.bootId}\u0000${entry.pid}\u0000${entry.pidStart}\u0000${entry.port}`;
    if (confirmed.has(key)) return url;
    // Порт слушает pid строки, и этот pid жив с тем же стартом — проверка платформы.
    if (!hasValue(await verifyCoreEntry(entry, deps))) return null;
    confirmed.add(key);
    return url;
  };
}

function newestEntry(procsPath: string): ProcEntry | undefined {
  const read = readProcs(procsPath);
  if (!('value' in read)) return undefined;
  return [...read.value.cores].sort((a, b) => b.startedAt - a.startedAt)[0];
}

const trim = (url: string): string => url.replace(/\/+$/, '');

/**
 * Адрес самого позднего ядра в `procs.json`, если он не тот, что отказал, и прошёл проверку.
 * Мёртвые строки чистит регистрация следующего ядра, поэтому позднейшая строка — живое ядро или
 * ещё никакое (файла нет, мусор, отказавший или непроверенный адрес — `null`: мост ждёт).
 */
export async function newestCore(
  procsPath: string,
  current: string,
  check: CoreCheck = coreCheck(),
): Promise<string | null> {
  const newest = newestEntry(procsPath);
  if (!newest || trim(newest.url) === trim(current)) return null;
  return check(newest, procsPath);
}

/**
 * Адрес ядра, запущенного позже `since` и прошедшего проверку: только оно — заведомо не то,
 * что получило оборванный запрос (адрес может совпасть — порт освободился). Нет — `null`.
 */
export async function coreSince(
  procsPath: string,
  since: number,
  check: CoreCheck = coreCheck(),
): Promise<string | null> {
  const newest = newestEntry(procsPath);
  if (!newest || newest.startedAt <= since) return null;
  return check(newest, procsPath);
}
