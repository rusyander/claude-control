import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { identityOfPid } from './process-identity.ts';
import type { ProcessIdentity } from './process-table.ts';
import { spawnResolved } from './spawn.ts';
import { stopTree, type TreeStopDeps } from './tree-stop.ts';

/**
 * Запуск команды установки зависимостей в копии (04:98): без оболочки (`spawnResolved` разбирает
 * `.cmd`-обёртки npm/pnpm до настоящей цели), окружение закреплено вызывающим + `CI=1` (установщик
 * не задаёт вопросов и не рисует прогресс), весь вывод — в файл лога, в память — только хвост.
 * Потолок времени останавливает ДЕРЕВО (`stopTree` по личности и метке): установщик поднимает
 * детей (postinstall, node-gyp), и снятый один корень оставил бы их писать в копию.
 */

export interface InstallSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Полное окружение (пин задачи); ничего не наследуется. */
  env: Record<string, string>;
  timeoutMs: number;
  logFile: string;
  /** Подмена остановки дерева — только тесты отказов. */
  stopDeps?: TreeStopDeps;
  /** Признак строки, первую из которых вернуть (`firstLine`) — по всему потоку, не по хвосту. */
  firstLineOf?: (line: string) => boolean;
}

export interface InstallOutcome {
  exit: number | null;
  timedOut: boolean;
  refused?: string;
  ms: number;
  /** Последние байты вывода (stdout+stderr вперемешку, как в логе). */
  output: string;
  /** Остаток дерева после остановки по сроку — назван, а не «снят». */
  leftover?: string;
  /** Первая строка вывода, подошедшая под `firstLineOf`, — даже если хвост её уже не держит. */
  firstLine?: string;
}

const KEEP_BYTES = 64 * 1024;
/** Недописанная строка длиннее этого — режется: признак сверяется с началом, память не растёт. */
const LINE_MAX = 8 * 1024;
const MARKER = 'AGENTDECK_TREE';

export async function runInstall(spec: InstallSpec): Promise<InstallOutcome> {
  const started = Date.now();
  mkdirSync(dirname(spec.logFile), { recursive: true });
  const log = createWriteStream(spec.logFile, { flags: 'a' });
  const marker = `copy-install-${randomUUID()}`;
  const head = `$ ${spec.command} ${spec.args.join(' ')}\n`;
  log.write(head);
  let kept = Buffer.from(head);
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let firstLine: string | undefined;
  const scan = (text: string, flush: boolean): void => {
    if (!spec.firstLineOf || firstLine !== undefined) return;
    const lines = (partial + text).split(/\r?\n/);
    partial = flush ? '' : (lines.pop() ?? '').slice(0, LINE_MAX);
    firstLine = lines.find((line) => spec.firstLineOf?.(line));
  };
  const keep = (chunk: Buffer): void => {
    log.write(chunk);
    kept = Buffer.concat([kept, chunk]);
    if (kept.length > KEEP_BYTES) kept = kept.subarray(kept.length - KEEP_BYTES);
  };
  const keepChild = (chunk: Buffer): void => {
    keep(chunk);
    scan(decoder.write(chunk), false);
  };
  const closeLog = (): Promise<void> => new Promise((done) => log.end(() => done()));

  // Запуск синхронный, слушатели — в том же такте: быстрый установщик («нечего ставить»)
  // успевает выйти, пока читается личность, и Node сливает его вывод и шлёт 'close' без нас —
  // ответ потерял бы вывод и ждал бы 'close' до потолка времени. Личность читается после.
  const spawned = spawnResolved({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: { ...spec.env, CI: '1', [MARKER]: marker },
    ownGroup: true,
  });
  if (!spawned.ok) {
    keep(Buffer.from(`[core] refused: ${spawned.reason}\n`));
    await closeLog();
    return {
      exit: null,
      timedOut: false,
      refused: spawned.reason,
      ms: Date.now() - started,
      output: kept.toString('utf8'),
    };
  }
  const child = spawned.child;
  child.stdin?.end();
  child.stdout?.on('data', keepChild);
  child.stderr?.on('data', keepChild);

  let timedOut = false;
  let stopped: Promise<string | undefined> | undefined;
  const exited = new Promise<number | null>((done) => {
    child.on('error', (error) => {
      keep(Buffer.from(`[core] error: ${error.message}\n`));
      done(null);
    });
    child.on('close', (code) => done(code));
  });
  const identity: Promise<Fact<ProcessIdentity>> =
    child.pid === undefined
      ? Promise.resolve({ unknown: 'spawn returned no pid' })
      : identityOfPid(child.pid).catch((error: unknown) => ({
          unknown: error instanceof Error ? error.message : String(error),
        }));
  const timer = setTimeout(() => {
    timedOut = true;
    stopped = identity
      .then((known) => stopInstall(known, child.pid, marker, spec.stopDeps))
      .then((left) => {
        // Корень снят, а 'close' не пришёл (поток держит внук): ждать его вечно не на что.
        child.stdout?.destroy();
        child.stderr?.destroy();
        return left;
      });
  }, spec.timeoutMs);
  const exit = await exited;
  clearTimeout(timer);
  // Остаток дерева читается ДО ответа: 'close' корня приходит раньше отчёта снятия.
  const leftover = stopped ? await stopped : undefined;
  scan(decoder.end(), true);
  const ms = Date.now() - started;
  keep(
    Buffer.from(
      timedOut ? `[core] stopped after ${spec.timeoutMs} ms\n` : `[core] exit ${exit ?? 'none'}\n`,
    ),
  );
  await closeLog();
  return {
    exit: timedOut ? null : exit,
    timedOut,
    ms,
    output: kept.toString('utf8'),
    ...(leftover ? { leftover } : {}),
    ...(firstLine === undefined ? {} : { firstLine }),
  };
}

async function stopInstall(
  identity: Fact<ProcessIdentity> | undefined,
  pid: number | undefined,
  marker: string,
  deps: TreeStopDeps = {},
): Promise<string | undefined> {
  if (pid === undefined) return 'no pid to stop';
  // Личность не прочиталась — снимаем по метке окружения: сигнал группе по голому номеру мог
  // бы задеть чужую группу (тот же приём, что у снятия сервера модели).
  const known = identity && 'value' in identity ? identity.value : undefined;
  const report = await stopTree(
    known ?? { pid, start: `unread:${pid}` },
    { group: known !== undefined, marker: { name: MARKER, value: marker }, graceMs: 2_000 },
    deps,
  );
  if (report.residual.length === 0 && !report.unknown) return undefined;
  return `tree residual: ${report.residual.map((p) => p.pid).join(', ') || '-'}${report.unknown ? `; ${report.unknown}` : ''}`;
}
