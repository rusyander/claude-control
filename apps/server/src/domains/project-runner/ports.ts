import { createConnection } from 'node:net';
import type { PortHoldersInfo } from '@claude-control/contracts';
import { isWindows, PROBE_HOSTS } from './project-runner.constants.ts';
import { killTree, runLines } from './os-process.ts';

/**
 * Порт: слушает ли его кто-нибудь, кто именно и как его освободить.
 *
 * Занятость определяет TCP-проба, а данные ОС (`netstat`/`lsof`) — только имена
 * держателей: их может не оказаться, и это не значит «порт свободен».
 */

/** Одна попытка TCP-подключения к конкретному хосту: слушает он или нет. */
function connectOnce(port: number, host: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ port, host });
    const settle = (ok: boolean): void => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

/**
 * Слушает ли уже кто-нибудь этот порт — по обеим семьям адресов сразу.
 *
 * `localhost` на Windows разрешается в `::1`, и dev-сервер сплошь и рядом
 * слушает ТОЛЬКО его (или наоборот, только 127.0.0.1). Проба по одному хосту
 * объявляла бы живой сервер «работает, адрес не определён» — ровно тот случай,
 * когда кнопка «Перейти» не появлялась.
 */
export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((settle) => {
    let left = PROBE_HOSTS.length;
    let done = false;
    for (const host of PROBE_HOSTS) {
      void connectOnce(port, host).then((ok) => {
        if (done) return;
        // Первый успех решает: ждать вторую семью адресов незачем, а на хосте
        // без IPv6 её попытка может висеть до собственного таймаута.
        if (ok) {
          done = true;
          settle(true);
          return;
        }
        left -= 1;
        if (left === 0) {
          done = true;
          settle(false);
        }
      });
    }
  });
}

/**
 * Имена процессов по списку PID — чтобы пользователь видел, кого ему предлагают
 * убить.
 *
 * ОДИН вызов на весь список, а не по вызову на PID: `tasklist` с фильтром
 * стоит секунды, а `spawnSync` держит цикл событий — сервер панели на это время
 * замирает целиком. Полный список процессов стоит столько же, сколько один
 * отфильтрованный, поэтому берём его разом и раскладываем в карту.
 */
function processNames(pids: number[]): Map<number, string> {
  const names = new Map<number, string>();
  if (pids.length === 0) return names;

  if (isWindows) {
    for (const line of runLines('tasklist', ['/NH', '/FO', 'CSV'])) {
      // CSV: "имя.exe","PID","сессия",...
      const parts = /^"([^"]+)","(\d+)"/.exec(line);
      const pid = Number(parts?.[2]);
      if (parts?.[1] && Number.isInteger(pid)) names.set(pid, parts[1]);
    }
  } else {
    for (const line of runLines('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')])) {
      const parts = /^\s*(\d+)\s+(.+)$/.exec(line);
      const pid = Number(parts?.[1]);
      if (parts?.[2] && Number.isInteger(pid)) names.set(pid, parts[2].trim());
    }
  }
  return names;
}

/**
 * Кто слушает порт — по данным ОС.
 *
 * Windows: `netstat -ano` (единственный способ без сторонних утилит), POSIX:
 * `lsof`. Ни одна из команд не обязана существовать — пустой список значит
 * «не выяснили», а не «порт свободен»; занятость определяет TCP-проба.
 */
export function findPortHolders(port: number): number[] {
  const pids = new Set<number>();
  if (isWindows) {
    // Без `-p tcp`: с этим ключом netstat отдаёт только IPv4, а dev-серверы
    // сплошь и рядом слушают ровно `[::1]` — и порт «не находился».
    for (const line of runLines('netstat', ['-ano'])) {
      if (!/^\s*TCP\b/i.test(line) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const pid = Number(parts[parts.length - 1]);
      // Хвост локального адреса — именно `:порт`, иначе 8888 поймает и 18888.
      if (!local?.endsWith(`:${port}`) || !Number.isInteger(pid)) continue;
      if (pid > 4) pids.add(pid);
    }
  } else {
    for (const line of runLines('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
  }
  // Себя не показываем и тем более не убиваем: сервер панели тоже слушает порт.
  pids.delete(process.pid);
  return [...pids];
}

/**
 * Кто держит порт, с именами процессов и пометкой «это наш запуск».
 *
 * Занятость определяет TCP-проба, а не длина списка: `netstat`/`lsof` может не
 * оказаться или не показать чужой процесс из-под другого пользователя — тогда
 * порт занят, а держатели неизвестны. Обратное («список есть, а порт свободен»)
 * тоже бывает: строка могла устареть между двумя вызовами.
 */
export async function describePort(
  port: number,
  isOurs: (pid: number) => boolean,
): Promise<PortHoldersInfo> {
  const pids = findPortHolders(port);
  const names = processNames(pids);
  const holders = pids.map((pid) => ({
    pid,
    name: names.get(pid),
    ours: isOurs(pid),
  }));
  return { port, busy: (await isPortBusy(port)) || holders.length > 0, holders };
}

/**
 * Освободить порт: погасить деревья процессов, которые его слушают.
 *
 * Делается только по явной команде пользователя — панель сама не решает, что
 * чужой процесс лишний. Свой PID из списка уже исключён в `findPortHolders`.
 */
export async function freePort(
  port: number,
  isOurs: (pid: number) => boolean,
): Promise<PortHoldersInfo> {
  const killed: number[] = [];
  for (const pid of findPortHolders(port)) {
    killTree(pid);
    killed.push(pid);
  }
  // Порт отпускается не мгновенно — даём ОС дожить сокеты, потом перепроверяем.
  await new Promise((sleep) => setTimeout(sleep, 400));
  const after = await describePort(port, isOurs);
  return { ...after, killed };
}
