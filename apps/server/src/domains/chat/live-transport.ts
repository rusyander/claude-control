import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { killChildTree, killPidTree, type KillOptions } from '../../lib/process-tree.ts';
import { watchCliChild } from '../../lib/cli-spawn.ts';
import { isPidAlive } from './run-ledger.ts';

/**
 * Чем живая сессия говорит с процессом CLI (`live-session.ts`).
 *
 * Прямой запуск — трубы CLI у сервера, как было с первого дня живых сессий:
 * сервер умер — CLI видит конец ввода и выходит в конце хода вместе с фоном.
 * Через посредника (`live-relay.mjs`) — трубы у отдельного отвязанного процесса,
 * а сервер лишь подключается к его именованному каналу: перезапуск панели
 * рвёт подключение, а не ввод CLI, и новый сервер подключается снова (журнал
 * 29, 60, 69, 84).
 */

/** Что посредник знает о ходе на момент подключения (строка `relay_synced`). */
export interface RelaySynced {
  /** Идёт ход: сообщение ушло или `init` пришёл, а `result` ещё нет. */
  busy: boolean;
  /** Фоновые задачи агента по последнему `background_tasks_changed`. */
  background: number;
  /** Pid процесса, который поднял посредник (на Windows — оболочка `cmd.exe`). */
  childPid?: number;
}

export interface TransportHandlers {
  line(text: string): void;
  stderr(chunk: string): void;
  close(code: number, error?: Error, stderr?: string): void;
  synced?(info: RelaySynced): void;
}

export interface LiveTransport {
  /** Pid, по которому процесс сессии жив: CLI (прямо) или посредник. */
  readonly pid: number | undefined;
  /** Канал посредника — его пишут в журнал, чтобы подключиться после перезапуска. */
  readonly relay?: RelayAddress;
  write(line: string): void;
  /** Конец ввода: CLI доделывает ход и выходит сам. */
  end(): void;
  /**
   * Снять процесс. `'unconfirmed'` — процесс жив и не снят: номер нечем
   * проверить (нет снимка процессов, F-205), а чужое панель не трогает (F-145).
   */
  kill(): 'unconfirmed' | void;
  /**
   * Отпустить процесс, не трогая его: сервер уходит, а CLI за посредником живёт
   * дальше и ждёт следующего сервера. Прямой запуск без труб сервера не живёт —
   * его валим, как валили при выходе всегда.
   */
  detach(): void;
}

/** С чем поднимать процесс — подмножество `LiveLaunch`. */
export interface TransportLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  /** Куда класть описание запуска для посредника (папка процесса). */
  tempDir?: string;
}

export type TransportOpener = (
  launch: TransportLaunch,
  handlers: TransportHandlers,
) => LiveTransport;

/** Адрес канала посредника: именованный канал Windows или сокет в /tmp. */
export interface RelayAddress {
  pipe: string;
  pid: number;
  /**
   * Ключ канала: посредник принимает подключение только после строки
   * `relay_hello` с ним. Имя канала видно любому процессу машины (список
   * `\\.\pipe\`), а подключившийся первым получал бы ввод CLI — то есть ходы
   * агента от чужого имени. Нет ключа — посредник старый и пускает всех.
   */
  token?: string;
}

/** Первая строка подключения к посреднику: старый посредник служебную строку молча пропускает. */
export function relayHello(token: string): string {
  return `${JSON.stringify({ type: 'relay_hello', token })}\n`;
}

export const RELAY_SCRIPT = fileURLToPath(new URL('./live-relay.mjs', import.meta.url));
const RELAY_LAUNCHER = fileURLToPath(new URL('./live-relay-launch.mjs', import.meta.url));

/** Трубы CLI у сервера — прямой запуск. */
export const spawnDirect: TransportOpener = (launch, handlers) => {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    shell: launch.shell,
    windowsHide: true,
    env: launch.env,
  });
  // Ненулевой выход CLI — фоновому наблюдателю; до чтения stderr.
  watchCliChild(launch.command, launch.args, child);
  // Сбой запуска приходит событием, а не исключением, и без слушателя уносит
  // весь сервер (см. `ChatRun.run`). То же у stdin: запись в закрывшийся CLI
  // отдаёт EPIPE отдельным `error`.
  child.on('error', (error: Error) => handlers.close(-1, error));
  child.on('close', (code) => handlers.close(code ?? 0));
  child.stdin.on('error', () => undefined);
  child.stderr.on('data', (chunk: Buffer) => handlers.stderr(chunk.toString()));
  createInterface({ input: child.stdout }).on('line', (line) => handlers.line(line));
  return {
    get pid() {
      return child.pid;
    },
    write: (line) => child.stdin.write(line),
    end: () => child.stdin.end(),
    kill: () => killChildTree(child),
    detach: () => killChildTree(child),
  };
};

function newPipeName(): string {
  const id = `agentdeck-live-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

export interface RelayOptions {
  /** Сколько пытаться подключиться, пока посредник поднимает канал. */
  connectMs?: number;
  idleMs?: number;
  backgroundIdleMs?: number;
}

/**
 * Поднять CLI через посредника. Посредник отвязан от сервера (`detached`,
 * `unref`): перезапуск панели его не задевает. Описание запуска — файлом, а не
 * аргументом: в нём окружение CLI, и в командной строке его видел бы любой.
 */
export function relayOpener(options: RelayOptions = {}): TransportOpener {
  return (launch, handlers) => {
    const pipe = newPipeName();
    const token = randomBytes(16).toString('hex');
    const spec = join(launch.tempDir ?? tmpdir(), `relay-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(
      spec,
      JSON.stringify({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        shell: launch.shell,
        pipe,
        token,
        ...(options.idleMs ? { idleMs: options.idleMs } : {}),
        ...(options.backgroundIdleMs ? { backgroundIdleMs: options.backgroundIdleMs } : {}),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    // Посредника поднимает пусковой процесс и тут же выходит (`live-relay-launch.mjs`):
    // родителя-сервера у посредника нет, и `taskkill /T` по серверу его не достаёт.
    // Pid приходит строкой пускового процесса, до неё в адресе 0 — «ещё не знаем».
    const address: RelayAddress = { pipe, pid: 0, token };
    // Задание (job object) того, кто запустил сервер, посредник всё же наследует,
    // если оно не разрешает тихий выход: вырваться из него node не умеет
    // (CREATE_BREAKAWAY_FROM_JOB libuv не ставит). Отвязанность пускового процесса
    // на это не влияет — замер W3-4b одинаков в обе стороны.
    const launcher = spawn(process.execPath, [RELAY_LAUNCHER, RELAY_SCRIPT, spec], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    launcher.on('error', (error: Error) => handlers.close(-1, error));
    let out = '';
    launcher.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const pid = Number.parseInt(out, 10);
      if (!address.pid && pid > 0) address.pid = pid;
    });
    launcher.unref();
    return connectRelay(address, handlers, options.connectMs, { fresh: true });
  };
}

/**
 * Посредник пропал, не сказав кода выхода (убит снаружи, канал пережившего
 * прежний сервер посредника не поднялся).
 * Процесс CLI при этом потерян, но разговор — нет: стенограмма на диске, и
 * следующий ход продолжит ту же сессию. Метка нужна ленте: без неё причина
 * уходила строкой «Не удалось запустить «claude»: relay closed», и человек
 * читал это как поломку установки.
 */
export function relayLost(message: string): Error {
  return Object.assign(new Error(message), { relayLost: true });
}

export function isRelayLost(error: unknown): boolean {
  return error instanceof Error && (error as { relayLost?: unknown }).relayLost === true;
}

/**
 * Канал так и не поднялся. У посредника, пережившего прежний сервер, это
 * потеря процесса — разговор цел. У свежего запуска — сбой запуска: посредник
 * упал при старте, и каждая повторная отправка упадёт так же, поэтому обещание
 * «отправьте, и он продолжится» ложно, а сырую причину (труба) лента сохраняет.
 */
function unreachable(pipe: string, fresh: boolean): Error {
  const message = `relay ${pipe} unreachable`;
  return fresh ? new Error(`${message}: the relay channel never came up`) : relayLost(message);
}

/**
 * Подключиться к каналу посредника — свежего или пережившего прежний сервер.
 * Строки до подключения копятся: ход человека, отправленный в первые
 * миллисекунды, не должен теряться, пока посредник поднимает канал.
 */
export function connectRelay(
  address: RelayAddress,
  handlers: TransportHandlers,
  connectMs = 10_000,
  options: {
    fresh?: boolean;
    /**
     * Снятие дерева по номеру, когда канала нет. Подменяют тесты — снимок
     * процессов, который отказал (F-205), иначе не воспроизвести.
     */
    killTree?: (pid: number, options: KillOptions) => readonly number[];
  } = {},
): LiveTransport {
  const killTree = options.killTree ?? killPidTree;
  const queue: string[] = [];
  let socket: Socket | undefined;
  let closed = false;
  let exitSeen = false;
  // Когда посредник точно был жив под своим pid (канал поднялся): снятие по
  // номеру сверяет время создания процесса с этим мигом — номер, доставшийся
  // после смерти посредника чужому процессу, не снимается (`process-tree.ts`).
  let aliveAt = 0;
  // Канала нет — то, что номер наш, известно на миг подключения: свежий
  // посредник только что запущен, пережившего прежний сервер реестр усыновил,
  // проверив «жив и похож на CLI». Момент СНЯТИЯ этим не годился: номер,
  // освободившийся и занятый чужим между ними, снимался бы как свой.
  const ownedAt = Date.now();
  const until = ownedAt + connectMs;

  const close = (code: number, error?: Error, stderr?: string): void => {
    if (closed) return;
    closed = true;
    handlers.close(code, error, stderr);
  };

  const attempt = (): void => {
    if (closed) return;
    const next = connect(address.pipe);
    next.once('connect', () => {
      socket = next;
      aliveAt = Date.now();
      if (address.token) next.write(relayHello(address.token));
      for (const line of queue.splice(0)) next.write(line);
      createInterface({ input: next }).on('line', (line) => {
        if (line.startsWith('{"type":"relay_')) {
          const control = JSON.parse(line) as Record<string, unknown>;
          if (control.type === 'relay_synced') {
            // Посредник называет себя сам: пусковой процесс мог не успеть.
            if (typeof control.pid === 'number' && control.pid > 0) address.pid = control.pid;
            handlers.synced?.({
              busy: control.busy === true,
              background: typeof control.background === 'number' ? control.background : 0,
              ...(typeof control.childPid === 'number' ? { childPid: control.childPid } : {}),
            });
          }
          if (control.type === 'relay_exit') {
            exitSeen = true;
            const reason = typeof control.error === 'string' ? new Error(control.error) : undefined;
            const code = typeof control.code === 'number' ? control.code : 0;
            close(code, reason, typeof control.stderr === 'string' ? control.stderr : '');
          }
          return;
        }
        handlers.line(line);
      });
    });
    next.on('error', () => {
      if (socket === next) return;
      next.destroy();
      if (Date.now() < until) setTimeout(attempt, 50);
      else close(-1, unreachable(address.pipe, options.fresh === true));
    });
    next.on('close', () => {
      if (socket !== next) return;
      // Посредник ушёл, не сказав код выхода: убит снаружи (уборщик, taskkill).
      if (!exitSeen) close(-1, relayLost('relay closed'));
    });
  };
  attempt();

  const send = (line: string): void => {
    if (socket && !socket.destroyed) socket.write(line);
    else queue.push(line);
  };
  return {
    get pid() {
      return address.pid;
    },
    relay: address,
    write: send,
    end: () => send(`${JSON.stringify({ type: 'relay_end' })}\n`),
    kill: () => {
      if (socket && !socket.destroyed) {
        socket.write(`${JSON.stringify({ type: 'relay_kill' })}\n`);
        return;
      }
      // Канала ещё (или уже) нет — снимаем посредника деревом по pid; pid ещё не
      // пришёл — просьба уйдёт первой строкой, как только канал поднимется.
      if (address.pid) {
        const killed = killTree(address.pid, { spawnedAt: aliveAt || ownedAt });
        // Ничего не снято, а посредник жив: номер не сверить (нет снимка), и
        // снимать его вслепую нельзя. Сказать «снят» — бросить CLI работать без
        // присмотра со словом «остановлено» (F-145, то же у `DetachedRun.stop`).
        if (killed.length === 0 && isPidAlive(address.pid)) return 'unconfirmed';
      } else if (!closed) queue.push(`${JSON.stringify({ type: 'relay_kill' })}\n`);
    },
    detach: () => {
      // Молча: конец подключения — не конец процесса, и прогону о нём не говорим.
      closed = true;
      socket?.destroy();
    },
  };
}
