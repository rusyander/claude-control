import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { stopSession } from '../../../adapters/launcher/session-io.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import { liveBase } from '../../../platform/__fixtures__/clean-base.ts';
import { stopTree } from '../../../platform/tree-stop.ts';
import { parseStubServerRef } from '../../../routes/stub/stub.ts';
import type { StubTask } from '../stub-tasks.types.ts';
import type {
  AdapterUnderTest,
  ChildConfig,
  ChildLaunch,
  ChildResult,
  KillPoint,
  Until,
} from './e2e.types.ts';

/**
 * Стенд сквозного прогона на стороне теста: одноразовый репозиторий из `BASE_REPO`, дом ядра с
 * маршрутом-заглушкой в `config.json` (сценарий — модуль `script.ts` с ходами задачи), процесс
 * ядра (`core-child.ts`), счёт коммитов в копии и уборка всего, что пережило ядро.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'core-child.ts');
const SCRIPT = join(HERE, '..', 'script.ts');
export const ROUTE_NAME = 'e2e';

export interface Stand {
  root: string;
  repo: string;
  home: string;
  copies: string;
  sessions: string;
  cliHome: string;
  trace: string;
  task: StubTask;
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/** Есть ли CLI в PATH теста (живой прогон без него — пропуск, а не красное). */
export function hasCli(command: string): boolean {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 60_000,
  });
  return probe.status === 0;
}

export function makeStand(task: StubTask, prefix: string): Stand {
  // `AGENTDECK_E2E_KEEP=<dir>` — стенд вне temp прогона (тот уходит целиком): разбор красного.
  // База проверена на чистоту: под профилем человека CLI в слое `on` читал бы его `~/.claude`.
  const base = liveBase(process.env.AGENTDECK_E2E_KEEP);
  const root = realpathSync(mkdtempSync(join(base, prefix)));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '-b', task.input.repo.baseBranch]);
  git(repo, ['config', 'user.name', 'agentdeck-stub']);
  git(repo, ['config', 'user.email', 'stub@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  for (const [path, text] of Object.entries(task.input.repo.files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  const home = join(root, 'core');
  mkdirSync(home, { recursive: true });
  const trace = join(root, 'stub-trace.jsonl');
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      routes: {
        stub: [
          {
            name: ROUTE_NAME,
            script: { module: SCRIPT, export: 'scriptFor', args: [{ moves: task.moves }, 'done'] },
            trace,
          },
        ],
      },
    }),
  );
  return {
    root,
    repo,
    home,
    copies: join(root, 'copies'),
    sessions: join(root, 'sessions'),
    cliHome: join(root, 'cli-home'),
    trace,
    task,
  };
}

export interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  result: ChildResult | undefined;
  notes: Record<string, unknown>[];
  killed: Record<string, unknown>[];
  stderr: string;
}

/** Длина файла сейчас (0 — файла нет): с неё читаются записи запуска, начатого после замера. */
export function sizeOf(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * Записи JSON-строк с байта `from` (F-124: строки прежних запусков того же стенда не читаются).
 * Последняя строка без перевода строки — недописанная (процесс убит посреди записи): она
 * отбрасывается. Битая строка в середине — порча, она бросает с номером строки.
 */
export function jsonLines(file: string, from = 0): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file).subarray(from).toString('utf8');
  const lines = text.split('\n');
  // Хвост после последнего `\n` — пустой у целого файла, половина строки у оборванного.
  lines.pop();
  return lines
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`${file}: line ${i + 1} after byte ${from} is not JSON: ${String(error)}`, {
          cause: error,
        });
      }
    });
}

/** Подмена процесса ядра — только для проверки самой обвязки (`stand.test.ts`). */
export interface RunCoreLaunch {
  node?: string;
  child?: string;
}

export function configFor(
  s: Stand,
  adapter: AdapterUnderTest,
  until: Until,
  over: { taskId?: string; kill?: KillPoint; waitMs?: number } = {},
): ChildConfig {
  return {
    home: s.home,
    adapter,
    repo: s.repo,
    baseBranch: s.task.input.repo.baseBranch,
    copiesDir: s.copies,
    sessionsDir: s.sessions,
    cliHome: s.cliHome,
    routeId: `stub:${ROUTE_NAME}`,
    taskTitle: s.task.input.title,
    request: s.task.input.request,
    stepKind: s.task.input.stepKind,
    until,
    waitMs: over.waitMs ?? 120_000,
    ...(over.taskId ? { taskId: over.taskId } : {}),
    ...(over.kill ? { kill: over.kill } : {}),
  };
}

/** Один процесс ядра от загрузки до выхода (или смерти в точке). */
export function runCore(
  s: Pick<Stand, 'root'>,
  cfg: ChildConfig,
  timeoutMs = 240_000,
  launch: RunCoreLaunch = {},
): Promise<ChildRun> {
  // Свой `runId` на запуск и байтовые отметки журналов до запуска (F-124): итог, записи и
  // строки смерти — только этого запуска, даже если pid прежнего процесса стенда повторился.
  const config: ChildLaunch = { ...cfg, runId: randomUUID() };
  const notesFile = join(s.root, 'conduct.jsonl');
  const killFile = join(s.root, 'kill.jsonl');
  const notesFrom = sizeOf(notesFile);
  const killFrom = sizeOf(killFile);
  return new Promise((done, fail) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const child = spawn(
      launch.node ?? process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        launch.child ?? CHILD,
        Buffer.from(JSON.stringify(config)).toString('base64url'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.stdout?.resume();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() =>
        fail(
          new Error(`core child did not exit in ${timeoutMs} ms; stderr: ${stderr.slice(-2000)}`),
        ),
      );
    }, timeoutMs);
    // Процесс не запустился (нет node, нет прав): `exit` не придёт — без этого ждали бы таймаут.
    child.on('error', (error) =>
      settle(() => fail(new Error(`core child did not start: ${error.message}`))),
    );
    child.on('exit', (code, signal) => {
      // Сбой разбора итога или записей — отказ запуска с причиной, а не брошенное в обработчике
      // исключение, после которого обещание не решается никогда.
      settle(() => {
        try {
          const resultFile = join(s.root, `result-${config.runId}.json`);
          const ours = (n: Record<string, unknown>): boolean => n.pid === child.pid;
          done({
            code,
            signal,
            result: existsSync(resultFile)
              ? (JSON.parse(readFileSync(resultFile, 'utf8')) as ChildResult)
              : undefined,
            notes: jsonLines(notesFile, notesFrom).filter((n) => n.runId === config.runId),
            killed: jsonLines(killFile, killFrom).filter(ours),
            stderr,
          });
        } catch (error) {
          fail(
            new Error(
              `core child exited (${code ?? signal}) but its output is unreadable: ${String(error)}; stderr: ${stderr.slice(-2000)}`,
            ),
          );
        }
      });
    });
  });
}

/** Задача, которую создал первый процесс ядра (строка `task` его записей). */
export function taskIdOf(run: ChildRun): string {
  const note = run.notes.find((n) => n.event === 'task');
  if (!note) throw new Error(`no task note; stderr: ${run.stderr.slice(-2000)}`);
  return note.taskId as string;
}

export function journalOf(s: Stand, taskId: string): JournalLine[] {
  return readJournalLines(join(s.home, 'tasks', taskId), taskId).lines as JournalLine[];
}

/** Новые коммиты ветки копии над базой и текст файлов из последнего. */
export function commitsIn(
  copy: string,
  base: string,
  files: readonly string[],
): { count: number; files: Record<string, string | null> } {
  const count = Number(git(copy, ['rev-list', '--count', `${base}..HEAD`]).trim());
  const out: Record<string, string | null> = {};
  for (const file of files) {
    const show = spawnSync('git', ['show', `HEAD:${file}`], {
      cwd: copy,
      encoding: 'utf8',
      windowsHide: true,
    });
    out[file] = show.status === 0 ? show.stdout : null;
  }
  return { count, files: out };
}

/** Всё, что пережило ядро: хосты сессий (дерево) и серверы заглушки (по ссылке ресурса). */
export async function sweepStand(s: Stand): Promise<string[]> {
  const swept: string[] = [];
  if (existsSync(s.sessions)) {
    for (const name of readdirSync(s.sessions)) {
      const outcome = await stopSession(join(s.sessions, name), 'tree').catch((error: unknown) => ({
        how: `error ${String(error)}`,
      }));
      swept.push(`session ${name}: ${outcome.how}`);
    }
  }
  const tasks = join(s.home, 'tasks');
  if (existsSync(tasks)) {
    for (const taskId of readdirSync(tasks)) {
      const lines = readJournalLines(join(tasks, taskId), taskId).lines as JournalLine[];
      for (const line of lines) {
        if (line.kind !== 'resource.created') continue;
        const data = line.data as { kind: string; ref: string };
        if (data.kind !== 'stub-server') continue;
        const parsed = parseStubServerRef(data.ref);
        if ('unreadable' in parsed) continue;
        const report = await stopTree(parsed.identity).catch(() => undefined);
        swept.push(`stub ${parsed.port}: ${report ? 'stopped' : 'error'}`);
      }
    }
  }
  return swept;
}
