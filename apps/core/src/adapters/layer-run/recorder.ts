import { appendFileSync } from 'node:fs';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import {
  hookShell,
  hookVerdict,
  runHookCommand,
  type HookShell,
  type HookVerdict,
} from './hook-shell.ts';

/**
 * Запись хука человека в `observe` (P87, G7): `run.ts recorder --log <журнал> --hook <ключ>
 * --observed <список>`. Команда человека берётся из списка наблюдаемых по ключу — в argv записи
 * её нет (текст хука — данные, F-33). Исполняется тем же stdin, окружением и сроком, вердикт
 * пишется строкой JSON в журнал сеанса, CLI получает «разрешено»: код 0 и пустой stdout — всегда,
 * и при сбое самой записи (сбой назван в журнале, если журнал пишется).
 */

export interface RecorderLine {
  t: string;
  hook: string;
  event: string;
  exit: number | null;
  decision: HookVerdict;
  /** Почему `error`: не запустилась, срок, не команда, нет в списке. */
  detail?: string;
}

interface Observed {
  key: string;
  event: string;
  type?: string;
  command: string;
  timeout?: number;
}

export interface RecorderIo {
  stdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  cwd: string;
  os?: OsKind;
  now?: () => Date;
  /** Подмена оболочки — только тестам. */
  shell?: HookShell;
}

const DEFAULT_TIMEOUT_S = 60;

/**
 * Пустой журнал записи на старте `observe`: сводка на конце пишется и тогда, когда ни один хук
 * не сработал. Уже есть (повторный запуск в том же каталоге) — не трогается.
 */
export function openRecorderLog(path: string): void {
  appendFileSync(path, '', { encoding: 'utf8', mode: 0o600 });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function readObserved(path: string): Observed[] | string {
  const got = readBytesSync(path);
  if (!('value' in got)) return 'unknown' in got ? got.unknown : 'observed list absent';
  try {
    const list = JSON.parse(got.value.toString('utf8')) as unknown;
    return Array.isArray(list) ? (list as Observed[]) : 'observed list is not an array';
  } catch (error) {
    return `observed list unreadable: ${(error as Error).message}`;
  }
}

export async function recordHook(argv: readonly string[], io: RecorderIo): Promise<RecorderLine> {
  const key = flag(argv, '--hook') ?? '';
  const event = key.split('.')[0] ?? '';
  const stamp = (io.now ?? (() => new Date()))().toISOString();
  const fail = (detail: string): RecorderLine => ({
    t: stamp,
    hook: key,
    event,
    exit: null,
    decision: 'error',
    detail,
  });
  // stdin CLI читается всегда: хук без чтения оставил бы CLI ждать записи в канал.
  const stdin = await io.stdin();
  const observedPath = flag(argv, '--observed');
  if (!observedPath) return fail('no --observed list');
  const list = readObserved(observedPath);
  if (typeof list === 'string') return fail(list);
  const hook = list.find((h) => h.key === key);
  if (!hook) return fail(`hook ${key} not in the observed list`);
  if ((hook.type ?? 'command') !== 'command' || !hook.command) {
    return fail(`hook type ${hook.type ?? 'command'} cannot be replayed`);
  }
  const shell = io.shell ?? hookShell(io.env, io.os ?? currentOs());
  if (!shell.ok) return fail(shell.reason);
  const run = await runHookCommand({
    shell,
    command: hook.command,
    stdin,
    env: io.env,
    cwd: io.cwd,
    timeoutMs: (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
  });
  const line: RecorderLine = {
    t: stamp,
    hook: key,
    event: hook.event,
    exit: run.exit,
    decision: hookVerdict(run),
  };
  if (run.timedOut) line.detail = 'timed out';
  else if (run.error) line.detail = run.error;
  return line;
}

/** Процесс записи: всегда код 0 и пустой stdout — вердикт хука CLI не получает (G7). */
export async function runRecorderProcess(argv: readonly string[], io: RecorderIo): Promise<number> {
  let line: RecorderLine;
  try {
    line = await recordHook(argv, io);
  } catch (error) {
    line = {
      t: new Date().toISOString(),
      hook: flag(argv, '--hook') ?? '',
      event: (flag(argv, '--hook') ?? '').split('.')[0] ?? '',
      exit: null,
      decision: 'error',
      detail: `recorder: ${(error as Error).message}`,
    };
  }
  const log = flag(argv, '--log');
  if (log) {
    try {
      appendFileSync(log, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // Журнал не пишется — CLI всё равно получает «разрешено»; причина — в stderr хука.
      process.stderr.write(`agentdeck recorder: log not written: ${(error as Error).message}\n`);
    }
  }
  return 0;
}
