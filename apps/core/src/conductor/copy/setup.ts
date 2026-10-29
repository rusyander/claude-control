import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Profile, RepoPath, ServiceEndpoint } from '@agentdeck/contracts/core/records';
import { fileExists, readCopyText } from '../../platform/copy-fs.ts';
import { dirtyPaths, revertPaths, type CopyGitOptions } from '../../platform/copy-git.ts';
import { runInstall, type InstallOutcome, type InstallSpec } from '../../platform/install-run.ts';
import { isCopyEnvFile, rewriteEnv } from '../../verifier/env/index.ts';
import type {
  CopySetupDecision,
  CopySetupInput,
  EnvChangeView,
  InstallRun,
  MirrorReport,
  MirrorSettings,
} from './copy.types.ts';
import { decideCopySetup } from './decide.ts';
import { planInstall, type ConfiguredInstall } from './install-plan.ts';
import { firstErrorLine, isErrorLine, logTail } from './log.ts';
import { mirrorLocalLayer } from './mirror.ts';

/**
 * Настройка выложенной копии (04:97-99): зеркало локального слоя → переписывание `.env` под
 * эфемерные сервисы задачи (зона E, `verifier/env`) → установка зависимостей командой проекта →
 * откат lock-файлов и манифестов, которые установка переписала → решение `copy-setup`. Ни один
 * этап не бросает наружу: провал — факт этапа, и судья кладёт его хвост в решение (04:99).
 */

/** Lock-файлы и манифесты, которые установка переписывает «под себя» (перенесено из `lockfiles.ts`). */
export const LOCKFILES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  // `go mod download` дописывает go.sum и правит go.mod (разбор панели 23.10, D5).
  'go.mod',
  'go.sum',
  'uv.lock',
  'Cargo.lock',
];

/**
 * На любой глубине: шаг установки идёт в каждом корне стека (`services/api/go.mod` — глубина 3), и
 * переписанный там `go.sum` иначе остался бы грязным и ушёл бы в MR агентским `git add -A`.
 * Ведущий `**` с косой чертой у git ловит и корень.
 */
export const LOCKFILE_PATHSPECS: readonly string[] = LOCKFILES.map((name) => `:(glob)**/${name}`);

function isLockfile(path: string): boolean {
  return LOCKFILES.includes(path.slice(path.lastIndexOf('/') + 1));
}

export const INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface SetupInput {
  /** Основная копия репозитория (`task.created.repos[].path`). */
  main: string;
  /** Настоящий путь копии единицы. */
  copy: string;
  profile: Fact<Profile>;
  settings?: MirrorSettings;
  /** Адреса эфемерных сервисов задачи; пусто — сервисные переменные снимаются и называются. */
  endpoints: readonly ServiceEndpoint[];
  configured?: ConfiguredInstall;
  longPaths: CopySetupInput['longPaths'];
}

export interface SetupDeps {
  /** Полное окружение установки (пин задачи): ничего не наследуется. */
  env: Record<string, string>;
  /** Каталог логов установки (`<core home>/logs/copy/<unit>`). */
  logDir: string;
  timeoutMs?: number;
  git?: CopyGitOptions;
  /** Внешняя граница: запуск установщика (тесты дают крошечную программу, не сеть). */
  install?: (spec: InstallSpec) => Promise<InstallOutcome>;
  rewriteEnv?: typeof rewriteEnv;
}

export interface SetupResult {
  decision: CopySetupDecision;
  input: CopySetupInput;
}

function factOf<T>(read: () => Promise<Fact<T>>): Promise<Fact<T>> {
  return read().catch((error: unknown) => ({
    unknown: error instanceof Error ? error.message : String(error),
  }));
}

/**
 * Каталоги, куда зеркало положило файлы окружения: переписывание идёт и по ним, а не только по
 * корню и корням стеков — `docker/.env` с адресом настоящей базы иначе лёг бы в копию нетронутым
 * (P84). Файлы окружения, которых переписывание не читает, зеркало не кладёт вовсе (`mirror.ts`).
 */
function mirroredEnvDirs(mirror: Fact<MirrorReport>): RepoPath[] {
  if (!('value' in mirror)) return [];
  return mirror.value.mirrored
    .filter((path) => isCopyEnvFile(path.slice(path.lastIndexOf('/') + 1)))
    .map((path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''))
    .filter(Boolean);
}

async function envStage(
  input: SetupInput,
  roots: readonly RepoPath[],
  deps: SetupDeps,
): Promise<Fact<EnvChangeView[]>> {
  const rewrite = deps.rewriteEnv ?? rewriteEnv;
  const read = await factOf(() => rewrite(input.copy, input.endpoints, ['', ...roots]));
  if (!('value' in read)) return read;
  return {
    value: read.value.flatMap((file) =>
      file.changes.map((c) => ({ file: file.file, name: c.name, action: c.action, why: c.why })),
    ),
  };
}

async function installStage(
  input: SetupInput,
  plan: CopySetupInput['plan'],
  deps: SetupDeps,
): Promise<InstallRun[]> {
  const run = deps.install ?? runInstall;
  const runs: InstallRun[] = [];
  for (const [i, step] of plan.steps.entries()) {
    const logFile = join(
      deps.logDir,
      `install-${i + 1}-${step.command.replace(/[^\w.-]+/g, '_')}.log`,
    );
    const outcome = await run({
      command: step.command,
      args: step.args,
      cwd: step.root === '' ? input.copy : join(input.copy, step.root),
      env: deps.env,
      timeoutMs: deps.timeoutMs ?? INSTALL_TIMEOUT_MS,
      logFile,
      firstLineOf: isErrorLine,
    }).catch((error: unknown): InstallOutcome => ({
      exit: null,
      timedOut: false,
      refused: error instanceof Error ? error.message : String(error),
      ms: 0,
      output: '',
    }));
    // Пойманная в потоке строка — первая по всему выводу; без неё — по удержанным 64 КБ.
    const firstError = firstErrorLine(outcome.firstLine ?? outcome.output);
    runs.push({
      step,
      exit: outcome.exit,
      timedOut: outcome.timedOut,
      ...(outcome.refused ? { refused: outcome.refused } : {}),
      ms: outcome.ms,
      logFile,
      tail: logTail(outcome.output),
      ...(firstError ? { firstError } : {}),
      ...(outcome.leftover ? { leftover: outcome.leftover } : {}),
    });
  }
  return runs;
}

/**
 * Откат: lock-файлы, которые положило зеркало (правка человека в основной копии), не трогаются —
 * откатывается всё остальное грязное под их именами (F-64 панели). Источник легитимной грязи —
 * отчёт зеркала, а не снимок копии перед установкой: настройка идёт до первого шага агента, и
 * после краха посреди неё снимок уже держал бы переписанное прошлой установкой. Зеркало не
 * прочиталось — не откатывается ничего: вслепую можно откатить правку человека.
 */
async function revertStage(
  copy: string,
  mirror: Fact<MirrorReport>,
  git: CopyGitOptions,
): Promise<Fact<RepoPath[]>> {
  if (!('value' in mirror))
    return { unknown: `mirror report: ${'unknown' in mirror ? mirror.unknown : 'absent'}` };
  const keep = new Set(mirror.value.mirrored.filter(isLockfile));
  const after = await dirtyPaths(copy, LOCKFILE_PATHSPECS, git);
  if (!('value' in after)) return after;
  const churn = after.value.filter((d) => !keep.has(d.path));
  if (churn.length === 0) return { value: [] };
  return revertPaths(copy, churn, git);
}

export async function setupCopy(input: SetupInput, deps: SetupDeps): Promise<SetupResult> {
  const git = deps.git ?? {};
  const mirror = await factOf(() => mirrorLocalLayer(input.main, input.copy, input.settings, git));
  const profile = input.profile;
  const roots = 'value' in profile ? profile.value.stacks.map((s) => s.root).filter(Boolean) : [];
  const env = await envStage(input, [...roots, ...mirroredEnvDirs(mirror)], deps);
  const exists = (rel: RepoPath): boolean => fileExists(join(input.copy, rel));
  // Своя команда человека сильнее профиля: она идёт и тогда, когда профиль не прочитался.
  const plan =
    'value' in profile || input.configured?.command.trim()
      ? planInstall(
          'value' in profile ? profile.value : { stacks: [], packageManager: null },
          exists,
          input.configured,
          (rel) => readCopyText(join(input.copy, rel)),
        )
      : {
          steps: [],
          notes: [],
          unread: `profile: ${'unknown' in profile ? profile.unknown : 'absent'}`,
        };
  const installs = await installStage(input, plan, deps);
  // Откат и без установки в этом заходе: переписанное установкой до краха тоже её грязь.
  const reverted = await revertStage(input.copy, mirror, git);
  const setupInput: CopySetupInput = {
    mirror,
    env,
    plan,
    installs,
    reverted,
    longPaths: input.longPaths,
  };
  return { decision: decideCopySetup(setupInput), input: setupInput };
}
