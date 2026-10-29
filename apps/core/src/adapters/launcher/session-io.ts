import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { attachSession, readLines, type AttachOutcome } from '../../session-host/client.ts';
import {
  sessionFile,
  type ExitRecord,
  type Identity,
  type StreamName,
} from '../../session-host/protocol.ts';
import { pidAlive } from '../../platform/kept-launch.ts';
import { createLivenessProbe, identityOfPid } from '../../platform/process-identity.ts';
import { spawnResolved } from '../../platform/spawn.ts';
import { stopTree } from '../../platform/tree-stop.ts';
import { currentOs, sleep } from '../../platform/os-kind.ts';
import type {
  ArtifactCap,
  CappedArtifact,
  RunOnceResult,
  StopMode,
  StopOutcome,
} from './launcher.types.ts';

/**
 * Ввод-вывод запущенной сессии: строки потока от смещения, вывод с потолком, остановка и
 * короткий разовый запуск (`--version`, `--help`) — всё поверх хоста сессии и платформы.
 */

export { readLines };

function readExit(dir: string): ExitRecord | null {
  try {
    return JSON.parse(readFileSync(sessionFile(dir, 'exit'), 'utf8')) as ExitRecord;
  } catch {
    return null;
  }
}

export const DEFAULT_CAP: ArtifactCap = { headBytes: 64 * 1024, tailBytes: 192 * 1024 };

/** Байт-продолжение знака UTF-8 (`10xxxxxx`). */
const continuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** Наибольшая граница знака ≤ `at`: срез `[0, граница)` не рвёт знак. */
export function utf8Floor(buf: Buffer, at: number): number {
  let end = Math.min(at, buf.length);
  if (end >= buf.length) {
    // Целиком ли последний знак: ведущий байт говорит, сколько байт в знаке.
    let lead = end - 1;
    while (lead > 0 && continuation(buf[lead])) lead -= 1;
    const first = buf[lead] ?? 0;
    let size = 1;
    if (first >= 0xf0) size = 4;
    else if (first >= 0xe0) size = 3;
    else if (first >= 0xc0) size = 2;
    return lead + size <= end ? end : lead;
  }
  while (end > 0 && continuation(buf[end])) end -= 1;
  return end;
}

/** Наименьшая граница знака ≥ `at`: срез `[граница, …)` не начинается серединой знака. */
export function utf8Ceil(buf: Buffer, at: number): number {
  let start = at;
  while (start < buf.length && continuation(buf[start])) start += 1;
  return start;
}

/** Потолок вывода `runOnce` на поток: справка CLI — килобайты, бесконечный вывод не копится. */
export const RUN_ONCE_MAX_BYTES = 1024 * 1024;

/** Поток с потолком: копит байты до предела по границе знака, лишнее считает. */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private dropped = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: Buffer): void {
    const room = this.max - this.kept;
    if (room >= chunk.length && this.dropped === 0) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
      return;
    }
    const take = this.dropped === 0 ? Math.max(room, 0) : 0;
    if (take > 0) this.chunks.push(chunk.subarray(0, take));
    this.kept += take;
    this.dropped += chunk.length - take;
  }

  /** Склейка, затем одно декодирование: знак на стыке чанков не рвётся (F-97). */
  text(): string {
    const all = Buffer.concat(this.chunks);
    if (this.dropped === 0) return all.toString('utf8');
    const end = utf8Floor(all, all.length);
    const lost = this.dropped + all.length - end;
    return `${all.subarray(0, end).toString('utf8')}\n… [${lost} bytes dropped] …`;
  }
}

/**
 * Вывод CLI с потолком на ЧТЕНИИ (03: «stdout/stderr → capped artifacts»): голова и хвост,
 * середина выброшена и названа. Файл хост пишет без потолка — это его сторона (находка C).
 */
export function readArtifact(
  dir: string,
  stream: StreamName,
  cap: ArtifactCap = DEFAULT_CAP,
): CappedArtifact {
  const file = sessionFile(dir, stream);
  if (!existsSync(file)) return { text: '', bytes: 0, truncated: false };
  const bytes = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const read = (from: number, length: number): Buffer => {
      const buf = Buffer.alloc(length);
      const got = readSync(fd, buf, 0, length, from);
      return buf.subarray(0, got);
    };
    if (bytes <= cap.headBytes + cap.tailBytes)
      return { text: read(0, bytes).toString('utf8'), bytes, truncated: false };
    // Срез по байтам рвал бы знак UTF-8 на стыке (F-97): голова кончается, а хвост начинается
    // на границе знака; недочитанные байты знака идут в счёт выброшенных.
    const head = read(0, cap.headBytes);
    const headText = head.subarray(0, utf8Floor(head, head.length)).toString('utf8');
    const tail = read(bytes - cap.tailBytes, cap.tailBytes);
    const tailText = tail.subarray(utf8Ceil(tail, 0)).toString('utf8');
    const dropped =
      bytes - Buffer.byteLength(headText, 'utf8') - Buffer.byteLength(tailText, 'utf8');
    const text = `${headText}\n… [${dropped} bytes dropped] …\n${tailText}`;
    return { text, bytes, truncated: true };
  } finally {
    closeSync(fd);
  }
}

/** Сколько ждать ухода хоста после исхода CLI: сам он держится не дольше ~2 с (`host.ts`). */
export const HOST_EXIT_WAIT_MS = 5_000;
const HOST_POLL_MS = 10;

/**
 * Хост сессии уходит сам вслед за CLI: пишет exit.json, закрывает канал, выходит. Пока он жив,
 * каталог сессии занят — это его рабочая папка (Windows: удаление каталога падает EBUSY), а запуск
 * в тот же каталог отказывает «live host» (F-100). Номер свободен — хоста точно нет; номер занят
 * к сроку — личность сверяется свежим снимком: жив или не проверить — хост назван в остатке.
 */
async function hostLeft(host: Identity, waitMs: number): Promise<Identity[]> {
  const deadline = Date.now() + waitMs;
  while (pidAlive(host.pid)) {
    if (Date.now() >= deadline) {
      const verdict = await createLivenessProbe(undefined, 0).isAlive(host);
      return verdict === 'dead' ? [] : [host];
    }
    await sleep(HOST_POLL_MS);
  }
  return [];
}

/**
 * Остановка сессии. `soft` — закрыть stdin и дать CLI выйти самому (конец хода и фона), по
 * истечении срока — деревом; `tree` — сразу деревом (лист первым, POSIX: TERM → срок → KILL).
 * Ответ — только после ухода и самого хоста (его нет в дереве CLI, но каталог сессии держит он);
 * не ушёл за `hostWaitMs` — назван в остатке. Остаток называется, а не прячется.
 */
export async function stopSession(
  dir: string,
  mode: StopMode,
  graceMs = 5_000,
  hostWaitMs = HOST_EXIT_WAIT_MS,
): Promise<StopOutcome> {
  const attached = await attachSession(dir);
  const outcome = await stopAttached(dir, attached, mode, graceMs);
  // Потерянный хост мёртв по проверке, а `unknown` записи хоста не даёт — ждать некого.
  const host = attached.state === 'live' || attached.state === 'exited' ? attached.record : null;
  if (!host) return outcome;
  const left = await hostLeft(host.host, hostWaitMs);
  if (left.length === 0) return outcome;
  return {
    ...outcome,
    residual: [...outcome.residual, ...left],
    reason: `session host pid ${host.host.pid} still alive ${hostWaitMs} ms after the CLI ended`,
  };
}

/** Исход из exit.json: остаток и сомнение остановки хоста — как записаны (старая запись — без них). */
function alreadyExited(exit: ExitRecord): StopOutcome {
  return {
    how: 'already-exited',
    residual: exit.residual ?? [],
    code: exit.code,
    ...(typeof exit.unknown === 'string' ? { unknown: exit.unknown } : {}),
  };
}

async function stopAttached(
  dir: string,
  attached: AttachOutcome,
  mode: StopMode,
  graceMs: number,
): Promise<StopOutcome> {
  if (attached.state === 'exited') return alreadyExited(attached.exit);
  if (attached.state === 'lost' || attached.state === 'unknown') {
    // Хост дописал исход и сбросил канал, пока шло подключение: это выход, а не потеря.
    const late = readExit(dir);
    if (late) return alreadyExited(late);
    return { how: 'lost', residual: [], reason: attached.reason };
  }
  const session = attached.session;
  try {
    if (mode === 'soft') {
      let code: number | null | undefined;
      session.onExit((exit) => {
        code = exit.code;
      });
      session.end();
      const deadline = Date.now() + graceMs;
      while (code === undefined && Date.now() < deadline) await sleep(50);
      if (code !== undefined) return { how: 'exited', residual: [], code };
    }
    const report = await session.stop(graceMs);
    return {
      how: 'tree',
      residual: report.residual,
      ...(report.unknown === undefined ? {} : { unknown: report.unknown }),
    };
  } finally {
    session.close();
  }
}

/**
 * Короткий разовый запуск того же разрешения и того же закреплённого окружения — для
 * `--version` / `--help` (флаги включаются по справке установленной версии, 03).
 */
export function runOnce(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 20_000,
  maxBytes = RUN_ONCE_MAX_BYTES,
): Promise<RunOnceResult> {
  // Своя группа процессов (POSIX): по сроку снимается всё дерево, а не только прямой потомок.
  const outcome = spawnResolved({
    command,
    args,
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ownGroup: true,
  });
  if (!outcome.ok)
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      reason: outcome.reason,
    });
  const child = outcome.child;
  const stdout = new CappedOutput(maxBytes);
  const stderr = new CappedOutput(maxBytes);
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const texts = () => ({ stdout: stdout.text(), stderr: stderr.text() });
  return new Promise((done) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: RunOnceResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const timer = setTimeout(() => {
      // Срок вышел: исход — «таймаут», даже если `close` придёт, пока снимается дерево;
      // ответ — только когда дерево снято.
      timedOut = true;
      void killTree(child.pid).finally(() =>
        finish({ ok: false, code: null, ...texts(), reason: `timeout ${timeoutMs} ms` }),
      );
    }, timeoutMs);
    child.on('error', (error) => {
      if (!timedOut) finish({ ok: false, code: null, ...texts(), reason: error.message });
    });
    child.on('close', (code) => {
      if (!timedOut) finish({ ok: code === 0, code, ...texts() });
    });
  });
}

/**
 * Снятие разового запуска по сроку деревом (F-97): `child.kill()` убил бы лишь прямого потомка
 * (на Windows — обёртку `.cmd`), внуки держали бы трубы и жили дальше. Личности нет — хотя бы
 * прямой потомок.
 */
async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    const identity = await identityOfPid(pid);
    if ('value' in identity) {
      await stopTree(identity.value, { graceMs: 1_000, group: currentOs() !== 'win32' });
      return;
    }
  } catch {
    // Снимок таблицы не удался — ниже прямой сигнал.
  }
  try {
    process.kill(pid);
  } catch {
    // Уже вышел.
  }
}
