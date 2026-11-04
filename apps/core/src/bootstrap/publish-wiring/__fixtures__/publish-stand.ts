import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { startStubForge, type StubForge, type StubScenario } from '@agentdeck/stub-forge';
import { expect } from 'vitest';
import { createForgePort } from '../../../adapters/forge/index.ts';
import type { StepCtx, UnitCtx } from '../../../conductor/run/run.types.ts';
import { presetOf } from '../../../conductor/scenario/index.ts';
import { CREATED, openFresh, SOLO_UNIT } from '../../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { guardStand, type GuardStand } from '../../guard-wiring/__fixtures__/guard-stand.ts';
import { createPublishWiring, type PublishWiring } from '../index.ts';

/**
 * Публикатор на настоящем пути: основной репозиторий, копия-worktree единицы, голый «сервер» во
 * временной папке и заглушка форжа на loopback (настоящий порт GitLab ядра). Ни настоящего
 * удалённого, ни настоящего форжа; слияния и одобрения нет нигде. Общий стенд публикации и пробы
 * сдачи (`delivery-probe.ts`).
 */

const SCENARIO = { id: 'feature', version: 1 } as const;
const PUBLISH = presetOf(SCENARIO)!.steps.find((s) => s.kind === 'publish') as StepDef;

export interface PublishStand {
  st: GuardStand;
  task: LiveTask;
  stub: StubForge;
  wiring: PublishWiring;
  u: UnitCtx;
  s: StepCtx;
  lines(kind: string): Record<string, unknown>[];
}

const open: PublishStand[] = [];

/** Снять стенды, открытые с прошлого вызова (`afterEach` теста). */
export async function closePublishStands(): Promise<void> {
  for (const one of open.splice(0)) {
    one.task.close();
    await one.stub.stop();
    one.st.remove();
  }
}

export async function publishStand(scenario?: StubScenario, ciWait = false): Promise<PublishStand> {
  const unitId = newId();
  const branch = `agentdeck/${unitId.slice(0, 8)}`;
  const st = guardStand(branch);
  const stub = await startStubForge({ repo: st.bare, ...(scenario ? { scenario } : {}) });
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      title: 'Add the feature file',
      repos: [{ repoKey: 'r1', path: st.main, baseRef: 'main' }],
      scenario: SCENARIO,
      ciWait,
    },
  });
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch, ownedPaths: [], ...SOLO_UNIT },
  });
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: {
      rid: newId(),
      kind: 'copy',
      owner: 'core',
      release: 'unit-end',
      ref: JSON.stringify({ worktree: st.copy, repo: st.main }),
    },
  });
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: st.bare },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const env = {
    ...st.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const wiring = createPublishWiring(
    {
      registry: {
        live: (id: string) => (id === task.taskId ? task : undefined),
        liveTasks: () => [task],
      } as never,
      coreHome: join(st.root, 'core-home'),
      scenariosDir: join(st.root, 'scenarios'),
      note: () => undefined,
    },
    { git: { env }, forgeFor: () => ({ port, credential: null }) },
  );
  const u: UnitCtx = { taskId: task.taskId, unitId, repoKey: 'r1', copyDir: st.copy };
  const s: StepCtx = { ...u, stepId: newId(), def: PUBLISH, round: 0, sessionId: null };
  const one: PublishStand = {
    st,
    task,
    stub,
    wiring,
    u,
    s,
    lines: (kind) =>
      readJournalLines(task.dir, task.taskId)
        .lines.filter((l) => l.kind === kind)
        .map((l) => l.data as Record<string, unknown>),
  };
  open.push(one);
  return one;
}

const OK = { verdict: { ok: true as const }, compositionId: null as string | null };

/** Правка в копии и финальная проверка с составом: `compositionId` прошедшего итога. */
export async function composed(one: PublishStand): Promise<string> {
  writeFileSync(join(one.st.copy, 'feature.txt'), 'feature\n');
  const compositionId = newId();
  const got = await one.wiring.hooks.onFinalGate!(one.u, { ...OK, compositionId });
  expect(got).toEqual({ verdict: { ok: true }, compositionId });
  return compositionId;
}
