import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { seedSession } from '../../../conductor/model-tools/__fixtures__/seed.ts';
import type { ConductorHooks, StepCtx } from '../../../conductor/run/run.types.ts';
import { MINI_SCENARIO, openFresh } from '../../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { ConductorWiringDeps } from '../../conductor-wiring/conductor-wiring.types.ts';
import { guardHooks } from '../../conductor-wiring/guard.ts';

/**
 * Стенд стража публикации на настоящем git: основной репозиторий, копия-worktree на ветке единицы
 * и голый «удалённый» во временной папке. Глобальный и системный конфиг человека отрезаны
 * (`GIT_CONFIG_GLOBAL` — пустой файл стенда, `GIT_CONFIG_NOSYSTEM`): ни чтения, ни записи чужого
 * git; `extensions.worktreeConfig` пишется только в репозиторий стенда.
 */

export interface GuardStand {
  root: string;
  main: string;
  copy: string;
  bare: string;
  branch: string;
  /** Окружение git стенда без метки сеанса. */
  env: NodeJS.ProcessEnv;
  run(cwd: string, args: string[], extra?: Record<string, string>): SpawnSyncReturns<string>;
  /** git, падающий на ненулевом коде; вывод без хвостовых пробелов. */
  g(cwd: string, ...args: string[]): string;
  commitIn(dir: string, name: string): string;
  remove(): void;
}

export const SESSION_ENV = { AGENTDECK_TREE: 'unit-1' };

/**
 * Бюджет теста, который гонит настоящую публикацию на этом стенде (publish-wiring, опрос форжа и
 * задача ответов). Общие 20 с ядра здесь малы не из-за ожидания, а из-за объёма работы: ни один
 * шаг не ждёт таймера, всё время — последовательные процессы git. Публикация единицы — ~40
 * процессов (финальная проверка, fetch базы, merge-tree, ls-remote, push), стенд опроса с
 * задачей-источником — ~60, тест с двумя MR — ~140. Процесс git на Windows стоит ~45 мс в тишине
 * и втрое больше под нагрузкой полного прогона ядра (замер 31.10: тест с двумя MR 6,7 с один,
 * в полном прогоне — за 20 с, красный; под искусственной нагрузкой вдвое тяжелее полного прогона
 * — 30–50 с). Тесты стража на этом стенде платят ещё и за хуки закрытия: каждый commit и push в
 * копии запускает sh-хук с несколькими вызовами git (замер 01.11: pre-commit ~1,9 с, тест — до 14 с
 * в одиночку при загруженной машине). Таймаут ловит зависание, а не медленную ОС: 60 с.
 */
export const REAL_PUBLISH_TIMEOUT_MS = 60_000;

const WORK = MINI_SCENARIO.steps[0] as StepDef;

export interface GuardStep {
  t: LiveTask;
  st: GuardStand;
  hooks: ConductorHooks;
  s: StepCtx;
  notes: string[];
  /** Закрыть журнал и снять стенд. */
  done(): void;
}

/**
 * Живая задача с единицей и шагом сеанса на ветке копии стенда и крючки стража над ними. Форж —
 * то, что даст тест (`null` — форжа нет); часы — для окна событий форжа.
 */
export async function guardStep(
  forge: ForgePort | null = null,
  now?: () => number,
): Promise<GuardStep> {
  const { task } = await openFresh();
  const unitId = newId();
  const st = guardStand(`agentdeck/${unitId.slice(0, 8)}`);
  const seeded = seedSession(task, { stepKind: 'work', unitId });
  const notes: string[] = [];
  const deps = {
    registry: { live: (id: string) => (id === task.taskId ? task : undefined) },
    layout: { root: join(st.root, 'core-home') },
    note: (event: string) => notes.push(event),
  } as unknown as ConductorWiringDeps;
  const hooks = guardHooks(deps, {
    git: { env: st.env },
    forgeFor: () => forge,
    ...(now ? { now } : {}),
  });
  const s: StepCtx = {
    taskId: task.taskId,
    unitId,
    repoKey: 'r1',
    copyDir: st.copy,
    stepId: seeded.stepId,
    def: WORK,
    round: 0,
    sessionId: seeded.sessionId,
  };
  return {
    t: task,
    st,
    hooks,
    s,
    notes,
    done: () => {
      task.close();
      st.remove();
    },
  };
}

/** Строки `signal` журнала задачи. */
export const signalsOf = (t: LiveTask) =>
  readJournalLines(t.dir, t.taskId)
    .lines.filter((l) => l.kind === 'signal')
    .map((l) => l.data as { signal: string; severity: string; detail: string });

export const kindsOf = (t: LiveTask) => readJournalLines(t.dir, t.taskId).lines.map((l) => l.kind);

const withoutMarker = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(base).filter(([k]) => k.toUpperCase() !== 'AGENTDECK_TREE'));

export function guardStand(branch = 'agentdeck/unit-1'): GuardStand {
  const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
  const globalFile = join(root, 'gitconfig');
  writeFileSync(globalFile, '');
  const env = {
    ...withoutMarker(process.env),
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const run = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...env, ...extra },
    });
  const g = (cwd: string, ...args: string[]): string => {
    const out = run(cwd, args);
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const commitIn = (dir: string, name: string): string => {
    writeFileSync(join(dir, name), name);
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', `add ${name}`);
    return g(dir, 'rev-parse', 'HEAD');
  };
  const main = join(root, 'main');
  const bare = join(root, 'origin.git');
  const copy = join(root, 'copy');
  mkdirSync(main);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  g(main, 'init', '-q', '-b', 'main');
  commitIn(main, 'a.txt');
  g(main, 'remote', 'add', 'origin', bare);
  g(main, 'push', '-q', 'origin', 'main');
  g(main, 'worktree', 'add', '-q', '-b', branch, copy);
  return {
    root,
    main,
    copy,
    bare,
    branch,
    env,
    run,
    g,
    commitIn,
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}
