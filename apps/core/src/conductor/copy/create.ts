import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Profile, ServiceEndpoint } from '@agentdeck/contracts/core/records';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { realDir } from '../../platform/copy-fs.ts';
import {
  addBranchWorktree,
  commitOf,
  copyState,
  currentBranch,
  dropUnfinishedCopy,
  ensureLongPaths,
  type CopyGitOptions,
} from '../../platform/copy-git.ts';
import { samePath } from '../../platform/paths.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { ActionFailed, runAction, type JsonValue } from '../outbox.ts';
import { unitBaseOf, type UnitCreated } from '../units/index.ts';
import type {
  CopyCreateFailed,
  CopyPlaced,
  CopySetupDecision,
  CopySetupInput,
  MirrorSettings,
} from './copy.types.ts';
import { decideCopySetup } from './decide.ts';
import { integrationBaseOf } from './integration-base.ts';
import type { ConfiguredInstall } from './install-plan.ts';
import {
  copyResourceOf,
  journaledSetup,
  ownCopyAttempt,
  pinnedBaseOf,
  unitRepoOf,
  type UnitRepo,
} from './journal-view.ts';
import { copyDirFor } from './location.ts';
import { setupCopy, type SetupDeps } from './setup.ts';

/**
 * Копия единицы (04:97-99) — место применения действия `copy-create` (01 §Outbox): эффект только
 * `worktree add` + длинные пути, всё остальное (зеркало, `.env`, установка) — настройка после
 * действия, и её итог — решение `copy-setup` в журнале. Нет решения по единице (крах посреди
 * настройки) — возобновление настраивает заново: до первого шага работы агента в копии нет.
 */

export interface CopyCreateOptions {
  /** Свой корень копий вместо соседнего `<репозиторий>-worktrees`. */
  root?: string;
  git?: CopyGitOptions;
}

/**
 * Эффект действия: целая копия на месте — берётся как есть (повтор после краха); начатая и не
 * законченная (`worktree add` упал посреди выкладки) — снимается и выкладывается заново; пустой
 * каталог — тоже. Рабочее дерево на месте (целое или нет) — наше, только если в журнале есть
 * прежняя попытка этой единицы на этот каталог (`owned`); иначе это дерево человека (например,
 * с переехавшим основным репозиторием — `.git` ведёт в никуда) — отказ с именем каталога: удалять
 * и присваивать не своё ядро не вправе. Каталог с чужим содержимым — отказ.
 */
async function placeCopy(
  repo: UnitRepo,
  dir: string,
  baseSha: string,
  git: CopyGitOptions,
  owned: boolean,
): Promise<JsonValue> {
  const state = copyState(dir);
  if ('unknown' in state) throw new ActionFailed('copy-unread', state.unknown);
  if ('value' in state && state.value === 'foreign')
    throw new ActionFailed('foreign-dir', `${dir} exists and is not a worktree`);
  if ('value' in state && state.value !== 'empty' && !owned)
    throw new ActionFailed(
      'foreign-copy',
      `${dir} holds a ${state.value} worktree this unit never started: not removed, not reused`,
    );
  if ('value' in state && state.value === 'initializing') {
    const dropped = await dropUnfinishedCopy(repo.path, dir, git);
    if ('failed' in dropped)
      throw new ActionFailed('partial-copy', `partial copy not removed: ${dropped.failed}`);
  }
  if ('value' in state && state.value === 'empty') {
    const swept = removeVerified(dir);
    if (!swept.removed)
      throw new ActionFailed('partial-copy', `empty dir not removed: ${swept.reason}`);
  }
  let head: string;
  if ('value' in state && state.value === 'complete') {
    // Целая копия на месте берётся, только если она — копия ЭТОЙ ветки: чужое дерево в том же
    // каталоге (ветка с тем же именем каталога) — отказ, а не «уже сделано».
    const on = await currentBranch(dir, git);
    if (!('value' in on) || on.value !== repo.branch)
      throw new ActionFailed(
        'foreign-copy',
        `${dir} holds ${'value' in on ? on.value : why(on)}, not ${repo.branch}`,
      );
    const at = await commitOf(dir, 'HEAD', git);
    if (!('value' in at))
      throw new ActionFailed('copy-unread', `HEAD of the existing copy: ${why(at)}`);
    head = at.value;
  } else {
    const added = await addBranchWorktree(repo.path, dir, repo.branch, baseSha, git);
    if ('failed' in added) throw new ActionFailed('worktree-add', added.failed);
    head = added.head;
  }
  const longPaths = await ensureLongPaths(repo.path, git);
  const real = realDir(dir);
  if (!('value' in real)) throw new ActionFailed('copy-unread', `realpath: ${why(real)}`);
  return {
    dir: real.value,
    branch: repo.branch,
    baseSha,
    head,
    longPaths: 'value' in longPaths ? longPaths.value : `unknown: ${why(longPaths)}`,
  };
}

function why(fact: Fact<unknown>): string {
  if ('unknown' in fact) return fact.unknown;
  return 'absent' in fact ? 'absent' : 'value';
}

/**
 * Основа ветки новой копии (02:73, G19) — решение `unitBaseOf`: ветка последнего предшественника
 * того же репозитория (его правки уже в основе), иначе приколотая база задачи. Свою основу копия
 * не считает: порядок единиц и их рёбра — знание деления.
 */
function branchBaseOf(task: LiveTask, unitId: string): string | { unknown: string } {
  const own = task.state.units[unitId];
  if (!own) return { unknown: `unit ${unitId} is not in the task fold` };
  const units: UnitCreated[] = Object.entries(task.state.units)
    .sort(([, a], [, b]) => a.createdSeq - b.createdSeq)
    .map(([id, u]) => ({
      unitId: id,
      name: u.name,
      repoKey: u.repoKey,
      branch: u.branch,
      ownedPaths: u.ownedPaths,
      after: u.after,
      contract: u.contract,
      splitId: u.splitId,
    }));
  const got = unitBaseOf(own, units, task.state.created?.repos ?? []);
  if ('unknown' in got) return got;
  return got.kind === 'predecessor' ? got.branch : got.sha;
}

export async function createUnitCopy(
  task: LiveTask,
  unitId: string,
  options: CopyCreateOptions = {},
): Promise<{ ok: true; placed: CopyPlaced; repo: UnitRepo } | { ok: false; failed: string }> {
  const repo = unitRepoOf(task, unitId);
  if ('missing' in repo) return { ok: false, failed: repo.missing };
  const git = options.git ?? {};
  // База закрепляется первой попыткой (sha в журнале): повтор после краха не переезжает на
  // сдвинувшуюся с тех пор ревизию-имя. Первая попытка берёт основу у зоны D (G19).
  const pinned = pinnedBaseOf(task, unitId);
  // Единица интеграции (W3-18b) растёт от слияния голов своих единиц, а не от одной из них.
  const baseRef =
    pinned ?? (await integrationBaseOf(task, unitId, repo.path, git)) ?? branchBaseOf(task, unitId);
  if (typeof baseRef !== 'string') return { ok: false, failed: `base: ${baseRef.unknown}` };
  const base = await commitOf(repo.path, baseRef, git);
  if (!('value' in base)) {
    return {
      ok: false,
      failed: `base ${baseRef}: ${'unknown' in base ? base.unknown : 'absent'}`,
    };
  }
  // Первая попытка на уже существующей ветке (ветка MR у задачи ответов): `worktree add` берёт
  // ветку как есть, и копия встала бы не на базу единицы — чужие локальные коммиты ушли бы в MR
  // пушем. Ветка не на базе — отказ с обоими sha; повтор после краха (база в журнале) — своя ветка.
  if (pinned === undefined) {
    const tip = await commitOf(repo.path, `refs/heads/${repo.branch}`, git);
    if ('unknown' in tip) return { ok: false, failed: `branch ${repo.branch}: ${tip.unknown}` };
    if ('value' in tip && tip.value !== base.value)
      return {
        ok: false,
        failed:
          `branch ${repo.branch} already exists at ${tip.value.slice(0, 12)}, not at the unit base ` +
          `${base.value.slice(0, 12)} — move or remove the local branch`,
      };
  }
  const dir = copyDirFor(repo.path, repo.branch, options.root);
  // Причина отказа эффекта (строка git `fatal: …`, путь чужого каталога) идёт хвостом шагу (04:99).
  let detail = '';
  const done = await runAction(
    task,
    { kind: 'copy-create', target: dir, idempotencyHint: `${repo.branch}@${base.value}` },
    (actionId) =>
      placeCopy(
        repo,
        dir,
        base.value,
        git,
        ownCopyAttempt(task, unitId, dir, actionId, (a, b) => samePath(a, b)),
      ).catch((error: unknown) => {
        detail = error instanceof Error ? error.message : String(error);
        throw error;
      }),
    { unitId },
  );
  if (!done.ok)
    return { ok: false, failed: `copy-create ${done.code}${detail ? `: ${detail}` : ''}` };
  const out = done.result as {
    dir: string;
    branch: string;
    baseSha: string;
    head: string;
    longPaths: string;
  };
  const longPaths: CopyPlaced['longPaths'] =
    out.longPaths === 'on' || out.longPaths === 'not-needed'
      ? { value: out.longPaths }
      : { unknown: out.longPaths.replace(/^unknown: /, '') };
  // Ресурс копии один на каталог: повтор действия поверх целой копии второй записи не даёт.
  if (!copyResourceOf(task, out.dir, (a, b) => samePath(a, b))) {
    task.append({
      kind: 'resource.created',
      actor: 'core',
      unitId,
      data: {
        rid: newId(),
        kind: 'copy',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ worktree: out.dir, repo: repo.path }),
      },
    });
  }
  return {
    ok: true,
    placed: { dir: out.dir, branch: out.branch, baseSha: out.baseSha, head: out.head, longPaths },
    repo,
  };
}

export interface PrepareOptions extends CopyCreateOptions {
  profileOf(repo: { repoKey: string; path: string }): Promise<Fact<Profile>>;
  settings?: MirrorSettings;
  endpoints?: readonly ServiceEndpoint[];
  configured?: ConfiguredInstall;
  setup: Omit<SetupDeps, 'git'>;
  /** Копия оценки (G6): без установки; следующий заход без флага её доставит. */
  deferInstall?: boolean;
}

function factKind(fact: Fact<unknown>): 'value' | 'absent' | 'unknown' {
  if ('value' in fact) return 'value';
  return 'absent' in fact ? 'absent' : 'unknown';
}

/** Решение `copy-setup` в журнал: факты каждого этапа по классу чтения, итог целиком. */
export function journalCopySetup(
  task: LiveTask,
  unitId: string,
  decision: CopySetupDecision,
  input: CopySetupInput | CopyCreateFailed,
): void {
  const facts =
    'createFailed' in input
      ? [{ readClass: 'copy.exists', kind: 'unknown' as const }]
      : [
          { readClass: 'copy.mirror', kind: factKind(input.mirror) },
          { readClass: 'copy.env', kind: factKind(input.env) },
          { readClass: 'copy.lockfiles', kind: factKind(input.reverted) },
          { readClass: 'copy.longpaths', kind: factKind(input.longPaths) },
        ];
  const installs = 'createFailed' in input ? [] : input.installs;
  task.append({
    kind: 'decision',
    actor: 'core',
    unitId,
    data: {
      decisionId: newId(),
      class: 'copy-setup',
      inputs: [],
      facts,
      numbers: {
        installs: installs.length,
        installMs: installs.reduce((sum, run) => sum + run.ms, 0),
        leftBehind: decision.leftBehind.length,
      },
      reasons: decision.brief
        .slice(0, 1)
        .concat(decision.failure ? [`failed at ${decision.failure.stage}`] : []),
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  });
}

/**
 * Копия единицы целиком: действие `copy-create`, затем настройка и её решение. Решение по
 * единице уже в журнале — настройка не повторяется (повтор после краха берёт копию как есть).
 * Ничего не бросает наружу: провал любого этапа — решение `failed` с хвостом для шага.
 */
export async function prepareUnitCopy(
  task: LiveTask,
  unitId: string,
  options: PrepareOptions,
): Promise<{ decision: CopySetupDecision; placed?: CopyPlaced; journaled: boolean }> {
  const created = await createUnitCopy(task, unitId, options);
  if (!created.ok) {
    const input = { createFailed: created.failed };
    const decision = decideCopySetup(input);
    journalCopySetup(task, unitId, decision, input);
    return { decision, journaled: true };
  }
  const { placed, repo } = created;
  const journaled = journaledSetup(task, unitId);
  // Записанное решение — окончательное, кроме отложенной установки копии оценки: её доставляет
  // заход без `deferInstall` (первый шаг работы), с повторным зеркалом только свежего — правку
  // человека в основной копии за время ожидания запуска копия получает, свою не теряет.
  const completing = journaled?.installDeferred === true && options.deferInstall !== true;
  if (journaled && !completing) return { decision: journaled, placed, journaled: false };
  const result = await setupCopy(
    {
      main: repo.path,
      copy: placed.dir,
      profile: await options
        .profileOf({ repoKey: repo.repoKey, path: repo.path })
        .catch((error: unknown) => ({
          unknown: error instanceof Error ? error.message : String(error),
        })),
      ...(options.settings ? { settings: options.settings } : {}),
      endpoints: options.endpoints ?? [],
      ...(options.configured ? { configured: options.configured } : {}),
      longPaths: placed.longPaths,
      ...(options.deferInstall ? { deferInstall: true } : {}),
      ...(completing ? { newerOnly: true } : {}),
    },
    { ...options.setup, ...(options.git ? { git: options.git } : {}) },
  );
  journalCopySetup(task, unitId, result.decision, result.input);
  return { decision: result.decision, placed, journaled: true };
}
