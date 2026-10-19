import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeavyQueueWait } from './heavy-wait.types.ts';

/** Каталог очереди тяжёлых шагов в данных панели — один на машину, общий всем группам. */
export const heavyQueueDir = (appData: string): string => join(appData, 'heavy-queue');

/**
 * Ждёт ли разговор места в очереди тяжёлых шагов (3.2) — для индикатора группы
 * в хабе: «ждёт очередь» отличается от «работает» только этим. Пока хук очереди
 * держит вызов, транскрипт показывает тот же незакрытый Bash, что и у идущей
 * команды, — правду знает лишь билет хука (`tools/heavy-queue-hook.mjs`): файл
 * `tickets/*.json` с `{ pid, session, created, command }`, который живёт ровно
 * столько, сколько хук ждёт.
 *
 * Билет мёртвого хука (процесс ушёл, файл остался) не считается: хук сам такие
 * убирает, но только на своём опросе, а индикатор читает чаще. Только чтение —
 * очередь принадлежит хуку, панель её не правит.
 */
export function heavyQueueWait(
  dir: string,
  sessionId: string,
  isAlive: (pid: number) => boolean = pidAlive,
): HeavyQueueWait | undefined {
  const root = join(dir, 'tickets');
  if (!sessionId || !existsSync(root)) return undefined;
  const live: Ticket[] = [];
  for (const name of safeList(root)) {
    if (!name.endsWith('.json')) continue;
    const ticket = readTicket(join(root, name));
    if (ticket && isAlive(ticket.pid)) live.push(ticket);
  }
  // Своих билетов бывает несколько (главный агент и субагент) — ждёт он с
  // самого раннего из них.
  const own = live
    .filter((ticket) => ticket.session === sessionId)
    .sort((a, b) => a.created - b.created)[0];
  if (!own) return undefined;
  // Впереди — чужие ожидающие, вставшие раньше: свои сессии хук не считает
  // помехой (`acquire` отфильтровывает их точно так же).
  const ahead = live.filter(
    (ticket) => ticket.session !== sessionId && ticket.created < own.created,
  ).length;
  return {
    since: new Date(own.created).toISOString(),
    ahead,
    ...(own.command ? { command: own.command } : {}),
  };
}

interface Ticket {
  pid: number;
  session: string;
  created: number;
  command?: string;
}

function readTicket(path: string): Ticket | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ticket>;
    if (!Number.isInteger(raw.pid) || !Number.isFinite(raw.created)) return undefined;
    return {
      pid: Number(raw.pid),
      session: String(raw.session ?? ''),
      created: Number(raw.created),
      ...(typeof raw.command === 'string' && raw.command ? { command: raw.command } : {}),
    };
  } catch {
    // Билет переписывается атомарно, но его могли убрать между списком и чтением.
    return undefined;
  }
}

function safeList(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** Тот же признак жизни, что у хука: EPERM — процесс есть, просто чужой. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
