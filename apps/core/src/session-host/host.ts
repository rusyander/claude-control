import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { spawnResolved } from '../platform/spawn.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import { hasValue, reasonOf } from '../platform/os-kind.ts';
import { stopTree, type TreeStopDeps } from '../platform/tree-stop.ts';
import { removeChannel } from '../platform/control-channel.ts';
import {
  decode,
  encode,
  lineSplitter,
  sessionFile,
  type ClientMessage,
  type ExitRecord,
  type HostMessage,
  type HostRecord,
  type HostSpec,
  type Identity,
} from './protocol.ts';

/** Метка дерева CLI: по ней остановка находит переродившихся потомков (09 §tree stop). */
export const TREE_MARKER = 'AGENTDECK_TREE';
const HELLO_MS = 5_000;
const HELLO_MAX = 4_096;
/**
 * Сколько cmdId хост помнит. Забывать нельзя (core-s2 F-105): вытесненный id при повторе был бы
 * записан в stdin второй раз. Поэтому помнятся все id этого CLI, а за пределом новый ввод
 * отказывается (память ограничена, двойной записи нет) — миллион ходов одной сессии не бывает.
 */
const APPLIED_MAX = 1_000_000;
/**
 * Короче ключ канала быть не может: запуск пишет 48 знаков. Пустой или обрезанный файл ключа
 * (сбой записи, чужая правка) открыл бы канал любому, кто пришлёт `''` (core-s2 F-58).
 */
export const TOKEN_MIN = 32;

function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function identity(pid: number): Promise<Identity> {
  const fact = await identityOfPid(pid);
  // Старт не прочитан — пустая строка: ядро увидит `unknown`, а не чужую жизнь (F25).
  return hasValue(fact) ? fact.value : { pid, start: '' };
}

function tokenMatches(expected: string, given: unknown): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(typeof given === 'string' ? given : '', 'utf8');
  return a.length >= TOKEN_MIN && a.length === b.length && timingSafeEqual(a, b);
}

function readToken(dir: string): string {
  const token = readFileSync(sessionFile(dir, 'token'), 'utf8').trim();
  if (token.length < TOKEN_MIN) throw new Error(`token file too short (${token.length} chars)`);
  return token;
}

function listen(server: Server, channel: string): Promise<void> {
  return new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(channel, () => {
      server.removeListener('error', fail);
      done();
    });
  });
}

type ChildEnd = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Подмены хоста — только внешняя граница ОС для тестов в процессе: чтение таблицы процессов и
 * поиск по метке у остановки дерева (их отказ иначе не вызвать на исправной машине).
 */
export interface HostDeps {
  treeStop?: TreeStopDeps;
}

export async function runHost(dir: string, deps: HostDeps = {}): Promise<void> {
  const specPath = sessionFile(dir, 'spec');
  let spec: HostSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as HostSpec;
  } finally {
    // В описании — окружение CLI с ключами: на диске ему не место дольше чтения (P112).
    rmSync(specPath, { force: true });
  }
  const token = readToken(dir);
  const self = await identity(process.pid);

  const exitWith = (record: Omit<ExitRecord, 'v' | 'at'>): ExitRecord => {
    const full: ExitRecord = { v: 1, ...record, at: Date.now() };
    writeJson(sessionFile(dir, 'exit'), full);
    return full;
  };

  let child: ChildProcess | undefined;
  let childId: Identity | null = null;
  /** Записанные в stdin cmdId (повтор → dup) и запись, ещё не подтверждённая ОС. */
  const applied = new Set<string>();
  const writing = new Map<string, Promise<string | null>>();
  let inputs = 0;
  let stdinClosed = false;
  let client: Socket | undefined;
  let stopping = false;
  let residual: Identity[] = [];
  let stopUnknown: string | undefined;
  let stopReport: Promise<void> | undefined;
  let exited: ExitRecord | null = null;

  const send = (socket: Socket | undefined, message: HostMessage): void => {
    if (socket && !socket.destroyed) socket.write(encode(message));
  };

  /**
   * Ввод подтверждается ТОЛЬКО после записи, которую ОС приняла (core-s2 F-22): после `end`,
   * закрытого stdin или выхода CLI — отказ с причиной; ошибка записи — тоже отказ, а cmdId не
   * считается применённым (повтор получит тот же отказ, а не ложный `dup`).
   */
  const input = (socket: Socket, cmdId: string, data: string): void => {
    if (applied.has(cmdId)) {
      send(socket, { t: 'ack', cmdId, dup: true });
      return;
    }
    const inFlight = writing.get(cmdId);
    if (inFlight) {
      void inFlight.then((failed) =>
        send(
          socket,
          failed ? { t: 'refused', cmdId, reason: failed } : { t: 'ack', cmdId, dup: true },
        ),
      );
      return;
    }
    const stdin = child?.stdin;
    if (exited) {
      send(socket, { t: 'refused', cmdId, reason: 'cli exited' });
      return;
    }
    if (stdinClosed || !stdin?.writable) {
      send(socket, { t: 'refused', cmdId, reason: 'cli stdin closed' });
      return;
    }
    if (applied.size + writing.size >= APPLIED_MAX) {
      send(socket, { t: 'refused', cmdId, reason: 'input id ledger full' });
      return;
    }
    const written = new Promise<string | null>((done) => {
      stdin.write(data, (error) => done(error ? reasonOf(error) : null));
    });
    writing.set(cmdId, written);
    void written.then((failed) => {
      writing.delete(cmdId);
      if (!failed) {
        applied.add(cmdId);
        inputs += 1;
      }
      send(
        socket,
        failed ? { t: 'refused', cmdId, reason: failed } : { t: 'ack', cmdId, dup: false },
      );
    });
  };

  const stop = (socket: Socket, graceMs: number | undefined): void => {
    stopping = true;
    // Вторая команда `stop` не запускает вторую остановку — ждёт первую.
    stopReport ??= stopTree(
      childId ?? { pid: child?.pid ?? -1, start: '' },
      {
        graceMs: graceMs ?? 5_000,
        group: true,
        marker: { name: TREE_MARKER, value: spec.sessionId },
      },
      deps.treeStop,
    ).then(
      (report) => {
        residual = report.residual;
        // Сомнение остановки идёт дальше, а не теряется: пустой остаток при непрочитанном поиске
        // по метке — не «снято чисто» (F25).
        if (report.unknown) stopUnknown = report.unknown;
      },
      (error: unknown) => {
        // Остановка не отчиталась — CLI считается оставшимся, а не снятым.
        residual = childId ? [childId] : [];
        stopUnknown = `tree stop failed: ${reasonOf(error)}`;
      },
    );
    void stopReport.then(() =>
      send(socket, {
        t: 'stopped',
        residual,
        ...(stopUnknown === undefined ? {} : { unknown: stopUnknown }),
      }),
    );
  };

  const handle = (socket: Socket, message: ClientMessage): void => {
    if (message.t === 'input') {
      input(socket, message.cmdId, message.data);
    } else if (message.t === 'end') {
      stdinClosed = true;
      child?.stdin?.end();
      send(socket, { t: 'ended' });
    } else if (message.t === 'status') {
      send(socket, {
        t: 'status',
        inputs,
        stdinOpen: !stdinClosed && child?.stdin?.writable === true,
      });
    } else if (message.t === 'stop') {
      stop(socket, message.graceMs);
    }
  };

  const attach = (socket: Socket): void => {
    // Подключение одно: прежнее принадлежало умершему ядру.
    if (client && client !== socket) client.destroy();
    client = socket;
    socket.on('close', () => {
      if (client === socket) client = undefined;
    });
    send(socket, { t: 'welcome', host: self, child: childId, exited });
    socket.on(
      'data',
      lineSplitter((line) => {
        const message = decode<ClientMessage>(line);
        if (message && client === socket) handle(socket, message);
      }),
    );
  };

  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    // CLI ещё не запущен — клиенту не с чем работать (канал слушает раньше запуска, F-21).
    if (!childId) {
      socket.destroy();
      return;
    }
    let head = Buffer.alloc(0);
    const refuse = (): void => {
      socket.destroy();
    };
    const timer = setTimeout(refuse, HELLO_MS);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(10);
      if (end < 0) {
        if (head.length > HELLO_MAX) {
          clearTimeout(timer);
          refuse();
        }
        return;
      }
      clearTimeout(timer);
      socket.removeListener('data', onData);
      const hello = decode<ClientMessage>(head.subarray(0, end).toString('utf8'));
      if (hello?.t !== 'hello' || !tokenMatches(token, hello.token)) {
        refuse();
        return;
      }
      const rest = head.subarray(end + 1);
      attach(socket);
      if (rest.length) socket.emit('data', rest);
    };
    socket.on('data', onData);
  });

  // Канал поднимается ДО запуска CLI (core-s2 F-21): занятый канал — отказ хоста без CLI-сироты.
  removeChannel(spec.channel);
  await listen(server, spec.channel);
  const closeChannel = (): void => {
    server.close();
    removeChannel(spec.channel);
  };

  let childExit: Promise<ChildEnd>;
  try {
    const outFd = openSync(sessionFile(dir, 'stdout'), 'a', 0o600);
    const errFd = openSync(sessionFile(dir, 'stderr'), 'a', 0o600);
    const outcome = spawnResolved({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...spec.env, [TREE_MARKER]: spec.sessionId },
      stdio: ['pipe', outFd, errFd],
      ownGroup: true,
      ...(spec.extraDirs ? { extraDirs: spec.extraDirs } : {}),
    });
    // Копии дескрипторов у CLI; хосту файлы вывода больше не нужны.
    closeSync(outFd);
    closeSync(errFd);
    // Окружение CLI ушло в процесс — в памяти хоста его больше не держим.
    spec.env = {};
    if (!outcome.ok) {
      exitWith({ code: null, signal: null, stopped: false, refused: outcome.reason });
      writeJson(sessionFile(dir, 'host'), {
        v: 1,
        host: self,
        child: null,
        channel: spec.channel,
        startedAt: Date.now(),
      } satisfies HostRecord);
      closeChannel();
      return;
    }
    const started = outcome.child;
    child = started;
    // Выход ловится сразу после запуска, ДО любого await: CLI, вышедший, пока читалась его
    // личность, иначе не оставлял exit.json, и хост жил вечно (живая находка 28.10, W2-B).
    // Запуск, сорвавшийся у ОС (`error` без pid), выхода не даёт вовсе — это тоже исход.
    childExit = new Promise<ChildEnd>((done) => {
      started.once('exit', (code, signal) => done({ code, signal }));
      started.on('error', () => {
        if (started.pid === undefined) done({ code: null, signal: null });
      });
    });
    started.stdin?.on('error', () => {
      stdinClosed = true;
    });
    started.stdin?.on('close', () => {
      stdinClosed = true;
    });
    childId = await identity(started.pid ?? -1);
    writeJson(sessionFile(dir, 'host'), {
      v: 1,
      host: self,
      child: childId,
      channel: spec.channel,
      startedAt: Date.now(),
    } satisfies HostRecord);
  } catch (error) {
    // Сбой после запуска: CLI с ключами не остаётся без владельца — дерево снимается, исход
    // пишется, и только потом хост падает (main.ts пишет host.err).
    if (child) {
      // Остаток и сомнение этой остановки — в исход: иначе сбой выглядел бы чисто снятым.
      const report = await stopTree(
        childId ?? { pid: child.pid ?? -1, start: '' },
        { graceMs: 1_000, group: true, marker: { name: TREE_MARKER, value: spec.sessionId } },
        deps.treeStop,
      ).catch((stopError: unknown) => ({
        residual: childId ? [childId] : [],
        unknown: `tree stop failed: ${reasonOf(stopError)}`,
      }));
      try {
        exitWith({
          code: null,
          signal: null,
          stopped: true,
          refused: `host failed: ${reasonOf(error)}`,
          ...(report.residual.length ? { residual: report.residual } : {}),
          ...(report.unknown ? { unknown: report.unknown } : {}),
        });
      } catch {
        /* исход не записался — причина всё равно уйдёт в host.err */
      }
    }
    closeChannel();
    throw error;
  }

  await new Promise<void>((done) => {
    // Остановка идёт и CLI вышел посреди неё: исход пишется ПОСЛЕ отчёта остановки — иначе
    // канал закрылся бы раньше `stopped`, а остаток дерева не попал бы в exit.json.
    const finishExit = async (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): Promise<void> => {
      await stopReport;
      stdinClosed = true;
      exited = exitWith({
        code,
        signal,
        stopped: stopping,
        ...(residual.length ? { residual } : {}),
        ...(stopUnknown === undefined ? {} : { unknown: stopUnknown }),
      });
      send(client, { t: 'exit', exit: exited });
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        closeChannel();
        done();
      };
      if (client && !client.destroyed) client.end(finish);
      else finish();
      // Клиент не дочитал — хост всё равно уходит: исход уже в exit.json.
      setTimeout(finish, 2_000).unref();
    };
    void childExit.then(({ code, signal }) => finishExit(code, signal));
  });
}
