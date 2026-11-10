import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { createForgePort } from '../../../adapters/forge/index.ts';
import { createUnitCopy } from '../../../conductor/copy/create.ts';
import { estimateTask, type CreateSeed, type SplitEnv } from '../../../conductor/estimate/index.ts';
import { seedSession } from '../../../conductor/model-tools/__fixtures__/seed.ts';
import type { StepCtx, UnitCtx } from '../../../conductor/run/run.types.ts';
import { presetOf } from '../../../conductor/scenario/index.ts';
import { estimateBody, testEnv } from '../../../conductor/split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../../../conductor/tasks.ts';
import { deps as journalDeps } from '../../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { layoutOf, type CoreHomeLayout } from '../../../platform/core-home.ts';
import type { GitRunner } from '../../../platform/git/git.types.ts';
import { guardStand, type GuardStand } from '../../guard-wiring/__fixtures__/guard-stand.ts';
import { createPublishWiring, type PublishWiring } from '../../publish-wiring/index.ts';
import { createPollWiring } from '../poll-wiring.ts';

/**
 * Стенд опроса форжа на настоящем пути (05:77-78): основной репозиторий и голый «сервер» во
 * временной папке, заглушка форжа на loopback, настоящий реестр задач, настоящая оценка (база
 * приколота fetch'ем), настоящий публикатор. Задача-источник опубликована и закончена `done`.
 */

export interface WorldOptions {
  /** Часы заглушки форжа (время событий ленты). */
  now?: () => number;
}

const FEATURE_PUBLISH = presetOf({ id: 'feature', version: 1 })!.steps.find(
  (s) => s.kind === 'publish',
) as StepDef;
export const ANSWER = presetOf({ id: 'answer-reviewers', version: 1 })!;
export const ANSWER_PUBLISH = ANSWER.steps.find((s) => s.kind === 'publish') as StepDef;
export const ANSWER_STEP = ANSWER.steps.find((s) => s.kind === 'answer-reviewers') as StepDef;
export const OK = { verdict: { ok: true as const }, compositionId: null as string | null };

/** Опубликованная и законченная задача-источник. */
export interface Published {
  source: LiveTask;
  unitId: string;
  branch: string;
  mrIid: number;
}

export interface World extends Published {
  st: GuardStand;
  stub: StubForge;
  port: ForgePort;
  layout: CoreHomeLayout;
  registry: TaskRegistry;
  publish: PublishWiring;
  git: { env: NodeJS.ProcessEnv };
  /** Среда деления опроса — тест подменяет её дороги (предпроверка, история). */
  env: SplitEnv;
  notes: { event: string; data: Record<string, unknown> }[];
  /** Ещё одна задача-источник с MR в том же проекте. */
  /** `seed` — дополнения оценки (этап 12: `boardEntry` источника с доски). */
  publishSource(title: string, file: string, seed?: CreateSeed): Promise<Published>;
  /** `run` — запуск git опроса (тест считает процессы круга); по умолчанию настоящий. */
  poller(run?: GitRunner): ReturnType<typeof createPollWiring>;
  enable(repos?: string[]): void;
}

const open: World[] = [];
/** Снять все стенды теста (`afterEach` файла теста). */
export async function closeWorlds(): Promise<void> {
  for (const w of open.splice(0)) {
    w.registry.closeAll();
    await w.stub.stop();
    w.st.remove();
  }
}

export const linesOf = (t: LiveTask, kind: string): Record<string, unknown>[] =>
  readJournalLines(t.dir, t.taskId)
    .lines.filter((l) => l.kind === kind)
    .map((l) => l.data as Record<string, unknown>);

export const tick = () => new Promise((r) => setTimeout(r, 5));

/** Живая копия единицы на её ветке — так её выкладывает дирижёр (`resource.created` вида copy). */
export function copyFor(w: { st: GuardStand }, task: LiveTask, unitId: string, dir: string): void {
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: {
      rid: newId(),
      kind: 'copy',
      owner: 'core',
      release: 'unit-end',
      ref: JSON.stringify({ worktree: dir, repo: w.st.main }),
    },
  });
}

/** Задача-источник: оценка → копия единицы 0 → финальная проверка → публикация → `done`. */
export async function world(options: WorldOptions = {}): Promise<World> {
  const st = guardStand('agentdeck/unused');
  const stub = await startStubForge({
    repo: st.bare,
    ...(options.now ? { now: options.now } : {}),
  });
  const layout = layoutOf(join(st.root, 'core-home'));
  const registry = createTaskRegistry(layout.tasks, journalDeps());
  const env = testEnv(layout.scenarios);
  const git = {
    env: {
      ...st.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  };
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: st.bare },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const notes: World['notes'] = [];
  const publish = createPublishWiring(
    {
      registry,
      coreHome: layout.root,
      scenariosDir: layout.scenarios,
      note: () => undefined,
    },
    { git, forgeFor: () => ({ port, credential: null }) },
  );
  const publishSource = async (
    title: string,
    file: string,
    seed?: CreateSeed,
  ): Promise<Published> => {
    const est = await estimateTask(estimateBody([st.main], { title }), registry, env, seed);
    if (est.status !== 202) throw new Error(`estimate: ${JSON.stringify(est)}`);
    const source = registry.live(est.reply.taskId)!;
    const [unitId, unit] = Object.entries(source.state.units)[0]!;
    const copy = join(st.root, `copy-${file}`);
    st.g(st.main, 'worktree', 'add', '-q', '-b', unit.branch, copy, 'origin/main');
    copyFor({ st }, source, unitId, copy);
    writeFileSync(join(copy, `${file}.txt`), `${file}\n`);
    const u: UnitCtx = { taskId: source.taskId, unitId, repoKey: unit.repoKey, copyDir: copy };
    const compositionId = newId();
    await publish.hooks.onFinalGate!(u, { ...OK, compositionId });
    const s: StepCtx = { ...u, stepId: newId(), def: FEATURE_PUBLISH, round: 0, sessionId: null };
    const got = await publish.hooks.onPublish!(s, compositionId);
    if (got?.kind !== 'published') throw new Error(`source publish: ${JSON.stringify(got)}`);
    source.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    // Задача закончена — её копия снята (ветка MR остаётся в основном репозитории).
    st.g(st.main, 'worktree', 'remove', '--force', copy);
    return { source, unitId, branch: unit.branch, mrIid: got.mrIid };
  };
  const first = await publishSource('Add the feature file', 'feature');
  const w: World = {
    st,
    stub,
    port,
    layout,
    registry,
    publish,
    git,
    env,
    notes,
    ...first,
    publishSource,
    poller: (run) =>
      createPollWiring({
        registry,
        split: () => env,
        layout,
        note: (event, data) => notes.push({ event, data }),
        git: run ? { ...git, run } : git,
        forgeFor: () => port,
      }),
    enable(repos = [st.main]) {
      writeFileSync(layout.config, JSON.stringify({ forgePoll: repos }));
    },
  };
  open.push(w);
  return w;
}

/** Ответ ревьюеру в заявлении шага ответа. */
export interface Reply {
  threadId: string;
  text: string;
  resolve: boolean;
}

/**
 * Задача ответов проходит путь дирижёра до публикации: копия единицы 0 — `createUnitCopy` (как
 * её выкладывает дирижёр, на существующей ветке MR), правка, финальная проверка, сданный шаг
 * ответа с `replies`, публикация. Отказ копии — `{ copyFailed }`, публикация не зовётся.
 */
export async function answerThroughPublish(
  w: World,
  answer: LiveTask,
  edit: { file: string; text: string; replies: Reply[] },
): Promise<{ copyFailed: string } | { published: Awaited<ReturnType<PublishHook>> }> {
  const [zeroId, zero] = Object.entries(answer.state.units)[0]!;
  const copy = await createUnitCopy(answer, zeroId, {
    root: join(w.st.root, 'copies'),
    git: w.git,
  });
  if (!copy.ok) return { copyFailed: copy.failed };
  const dir = copy.placed.dir;
  writeFileSync(join(dir, edit.file), edit.text);
  const u: UnitCtx = {
    taskId: answer.taskId,
    unitId: zeroId,
    repoKey: zero.repoKey,
    copyDir: dir,
  };
  const compositionId = newId();
  await w.publish.hooks.onFinalGate!(u, { ...OK, compositionId });
  const seeded = seedSession(answer, { stepKind: ANSWER_STEP.kind, unitId: zeroId });
  answer.append({
    kind: 'step.claimed',
    actor: 'core',
    stepId: seeded.stepId,
    data: {
      stepId: seeded.stepId,
      sessionId: seeded.sessionId,
      claim: {
        stepId: seeded.stepId,
        outcome: 'done',
        requirements: [],
        replies: edit.replies,
        summary: 'answered the reviewer',
      },
    },
  });
  for (const [event, from, to] of [
    ['check', 'running', 'checking'],
    ['checked-green', 'checking', 'done'],
  ] as const)
    answer.append({
      kind: 'step.transition',
      actor: 'core',
      stepId: seeded.stepId,
      data: { stepId: seeded.stepId, event, from, to },
    });
  const s: StepCtx = { ...u, stepId: newId(), def: ANSWER_PUBLISH, round: 0, sessionId: null };
  return { published: await w.publish.hooks.onPublish!(s, compositionId) };
}

type PublishHook = NonNullable<PublishWiring['hooks']['onPublish']>;

export const tasksBesides = (w: World, known: readonly string[]) =>
  w.registry
    .list()
    .map((t) => t.taskId)
    .filter((id) => !known.includes(id));
