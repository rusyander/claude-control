import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgePort } from '../../adapters/forge/index.ts';
import type { ConductorWiringDeps } from '../../bootstrap/conductor-wiring/conductor-wiring.types.ts';
import { createWiringHooks } from '../../bootstrap/conductor-wiring/wiring.ts';
import { copyWiring } from '../../bootstrap/copy-wiring.ts';
import {
  guardStand,
  type GuardStand,
} from '../../bootstrap/guard-wiring/__fixtures__/guard-stand.ts';
import { createPublishWiring } from '../../bootstrap/publish-wiring/index.ts';
import { CREATED, deps as journalDeps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { applyAnswer } from '../commands/answer.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { installer, PROFILE } from '../copy/__fixtures__/copy-harness.ts';
import { INTEGRATION_CONFLICT_SIGNAL, unitCopyOf } from '../copy/index.ts';
import { raiseHumanPoint } from '../human/raise.ts';
import { ROUND_CAP_ANSWERS, roundCapKey } from '../next/index.ts';
import { FakePort, ROUTE } from '../run/__fixtures__/run-harness.ts';
import { runTask } from '../run/run.ts';
import type { ConductorHooks, RunHandle } from '../run/run.types.ts';
import { presetOf } from '../scenario/index.ts';
import { createTaskRegistry } from '../tasks.ts';
import { INTEGRATION_ROLE, INTEGRATION_UNIT_NAME } from './index.ts';
import { INTEGRATION_GATE_STEP, integrationHooks } from './integration-hooks.ts';

/**
 * Конфликт интеграции решается в задаче (этап 11, W3-18b) на настоящем пути: настоящий
 * исполнитель (`runTask`, пресет ведущего), настоящий git (основной репозиторий, голый «сервер»),
 * настоящая копия единицы (слияние голов для интеграции), настоящий публикатор на заглушке форжа.
 * Подделаны только модель (сессии сдают шаг; правку единицы делает крючок после шага `work`) и
 * проверяющий финальной проверки (зелёный состав).
 *
 * Единицы A (api) и B (web) параллельны, C (docs) после A, интеграция — после всех. A и B правят
 * один `iface.ts`: ворота интеграции красные с названным файлом и парой веток, ни одного MR, круги
 * кончаются вопросом точки 6. Конфликт снят на ветке B, ответ «ещё круг» — ворота зелёные, MR
 * трёх единиц в порядке рёбер (C после A), каждое тело называет MR остальных.
 */

const IFACE = 'export interface Api {\n  ping(): void;\n}\n';
const EDITS: Record<string, Record<string, string>> = {
  api: {
    'iface.ts': IFACE.replace('ping', 'get'),
    'api.ts': 'export const api = 1;\n',
    'api.test.ts': "import { api } from './api';\nif (api !== 1) throw new Error('api');\n",
  },
  web: {
    'iface.ts': IFACE.replace('ping', 'list'),
    'web.ts': 'export const web = 1;\n',
    'web.test.ts': "import { web } from './web';\nif (web !== 1) throw new Error('web');\n",
  },
  docs: { 'docs.md': '# Api\n' },
};
/** Единица опубликована: MR есть; без нитей ревьюеров хвост сразу ведёт её к концу. */
const AFTER_PUBLISH: ReadonlySet<string> = new Set(['published', 'answering', 'done']);
const RESOLVED = 'export interface Api {\n  get(): void;\n  list(): void;\n}\n';

interface World {
  st: GuardStand;
  stub: StubForge;
  task: LiveTask;
  run: RunHandle;
  units: Record<'api' | 'web' | 'docs' | 'integration', string>;
}

const open: World[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) {
    await w.run.stop();
    w.task.close();
    await w.stub.stop();
    w.st.remove();
  }
});

/** Снимок задачи в сообщение таймаута: единицы, шаги с причинами, вопросы, хвост журнала. */
let DEBUG = (): string => '';
async function until(pred: () => boolean, what: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`until: ${what}: ${DEBUG()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Правка единицы `api` в ответе ревьюерам: голова сдвигается после зелёной интеграции (Q-1). */
const ANSWER_EDIT = { 'api.ts': 'export const api = 2;\n' };
/** Без конфликта: B не трогает `iface.ts`, интеграция зелёная с первого круга. */
const WEB_NO_CONFLICT = Object.fromEntries(
  Object.entries(EDITS['web']!).filter(([file]) => file !== 'iface.ts'),
);

interface WorldOpts {
  /** Нити ревьюера на каждом MR (сценарий заглушки): единицы отвечают и публикуются снова. */
  threads?: boolean;
}

async function world(opts: WorldOpts = {}): Promise<World> {
  const st = guardStand('agentdeck/unused');
  writeFileSync(join(st.main, 'iface.ts'), IFACE);
  st.g(st.main, 'add', '-A');
  st.g(st.main, 'commit', '-qm', 'iface');
  st.g(st.main, 'push', '-q', 'origin', 'main');
  const stub = await startStubForge({
    repo: st.bare,
    ...(opts.threads ? { scenario: 'review-threads-unseen' as const } : {}),
  });
  const env = {
    ...st.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const layout = layoutOf(join(st.root, 'core-home'));
  const registry = createTaskRegistry(layout.tasks, journalDeps());
  const task = await registry.create({
    ...CREATED,
    title: 'Shared api change',
    repos: [{ repoKey: 'r1', path: st.main, baseRef: 'main' }],
    scenario: { id: 'lead', version: 1 },
    allowedRoutes: [ROUTE],
  });
  const add = (name: string, after: string[], role?: typeof INTEGRATION_ROLE): string => {
    const unitId = newId();
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        name,
        repoKey: 'r1',
        branch: `agentdeck/${name}-${unitId.slice(-6)}`,
        ownedPaths: [],
        after,
        contract: false,
        splitId: null,
        ...(role ? { role } : {}),
      },
    });
    return unitId;
  };
  const api = add('api', []);
  const web = add('web', []);
  const docs = add('docs', [api]);
  const integration = add(INTEGRATION_UNIT_NAME, [api, web, docs], INTEGRATION_ROLE);
  const units = { api, web, docs, integration };
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });

  const copy = copyWiring({
    registry,
    layout,
    profileOf: async () => PROFILE,
    root: join(st.root, 'copies'),
    git: { env },
    install: installer().install,
    env: async () => ({ PATH: process.env.PATH ?? '' }),
  });
  // Старт единицы — настоящая обвязка зоны F (копия, правило конфликта интеграции).
  const wiring = createWiringHooks(
    { registry, layout, note: () => undefined } as unknown as ConductorWiringDeps,
    { copy },
  );
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: st.bare },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const publish = createPublishWiring(
    { registry, coreHome: layout.root, scenariosDir: layout.scenarios, note: () => undefined },
    { git: { env }, forgeFor: () => ({ port, credential: null }) },
  );
  const nameOf = (unitId: string) => task.state.units[unitId]?.name ?? '';
  const hooks: ConductorHooks[] = [
    { onUnitStart: wiring.onUnitStart! },
    integrationHooks({
      live: (id) => registry.live(id),
      prepare: (taskId, unitId) => copy.prepare(taskId, unitId),
      git: { env },
    }),
    {
      // «Модель» шага работы правит свою копию; состав коммитов делает финальная проверка.
      async postStep(s) {
        const name = nameOf(s.unitId);
        const edits =
          s.def.id === 'work'
            ? opts.threads && name === 'web'
              ? WEB_NO_CONFLICT
              : EDITS[name]
            : opts.threads && s.def.id === 'answer-reviewers' && name === 'api'
              ? ANSWER_EDIT
              : undefined;
        const dir = unitCopyOf(task, s.unitId)?.dir;
        if (edits && dir)
          for (const [file, text] of Object.entries(edits)) writeFileSync(join(dir, file), text);
        return { verdict: { ok: true }, facts: {} };
      },
      // Проверяющий: состав зелёный; композицию коммитов под него делает публикатор.
      async onFinalGate() {
        return { verdict: { ok: true }, compositionId: newId() };
      },
    },
    publish.hooks,
  ];
  const run = runTask(task, {
    hooks,
    scenarioOf: (ref) => presetOf(ref),
    sessions: Object.assign(new FakePort({}), { task }),
    raise: (r) => raiseHumanPoint(task, r),
    copyDirOf: (unitId) => unitCopyOf(task, unitId)?.dir ?? null,
    now: () => Date.now(),
  });
  const w: World = { st, stub, task, run, units };
  open.push(w);
  return w;
}

const lines = (task: LiveTask, kind: string) =>
  readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === kind);

const conflictSignals = (w: World) =>
  lines(w.task, 'signal')
    .map((l) => l.data as { signal: string; detail: string })
    .filter((d) => d.signal === INTEGRATION_CONFLICT_SIGNAL);

const capAskOf = (w: World) =>
  Object.entries(w.task.state.asks).find(
    ([, a]) =>
      a.state === 'open' &&
      (a.dedupe ?? '').replace(/:\d+$/, '') ===
        roundCapKey(w.units.integration, INTEGRATION_GATE_STEP, 0).replace(/:\d+$/, ''),
  );

async function answer(task: LiveTask, askId: string, text: string): Promise<void> {
  const command = {
    cmdId: newId(),
    kind: 'answer',
    target: { taskId: task.taskId },
    expectSeq: null,
    fields: { askId, answer: text },
  } as unknown as CommandEnvelope;
  await applyAnswer(task, command, commandEnv());
}

describe('W3-18b integration conflict resolved in the task, then per-unit MRs', () => {
  it('A and B edit iface.ts → the integration gate is red naming the file and both branches, no MR; resolved on B + "one more round" → gate green, MRs of A, B, C through the forge stub, C after A, each linking the others', async () => {
    const w = await world();
    const { task, units } = w;
    const branch = (id: string) => task.state.units[id]!.branch;
    DEBUG = () =>
      JSON.stringify({
        units: Object.values(task.state.units).map((u) => [u.name, u.state]),
        steps: Object.values(task.state.steps)
          .sort((a, b) => a.startedSeq - b.startedSeq)
          .map((s) => [task.state.units[s.unitId]?.name, s.stepDefId, s.round, s.state, s.reason]),
        asks: Object.values(task.state.asks).map((a) => [a.dedupe, a.state, a.answer]),
        tail: readJournalLines(task.dir, task.taskId)
          .lines.slice(-15)
          .map((l) => [l.kind, JSON.stringify(l.data).slice(0, 300)]),
      });

    // Красное: конфликт назван, единицы ждут интеграцию, ни одного MR, круги кончились вопросом.
    await until(() => capAskOf(w) !== undefined, 'the round-cap ask of the integration gate');
    const signals = conflictSignals(w);
    expect(signals.length).toBeGreaterThan(0);
    expect(JSON.parse(signals.at(-1)!.detail)).toEqual({
      files: ['iface.ts'],
      between: [branch(units.api), branch(units.web)],
    });
    const gates = Object.values(task.state.steps).filter(
      (s) => s.unitId === units.integration && s.stepDefId === INTEGRATION_GATE_STEP,
    );
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((s) => s.state !== 'done')).toBe(true);
    expect(task.state.units[units.integration]!.state).toBe('running');
    for (const id of [units.api, units.web, units.docs])
      expect(task.state.units[id]!.state).toBe('ready-to-publish');
    expect(unitCopyOf(task, units.integration)).toBeUndefined();
    expect(w.stub.state().mrs).toEqual([]);
    expect(lines(task, 'mr.created')).toEqual([]);

    // Конфликт снят в задаче: ветка B вбирает A с разрешённым `iface.ts`.
    const webCopy = unitCopyOf(task, units.web)!.dir;
    const merged = w.st.run(webCopy, ['merge', '--no-edit', branch(units.api)]);
    expect(merged.status).not.toBe(0);
    writeFileSync(join(webCopy, 'iface.ts'), RESOLVED);
    w.st.g(webCopy, 'add', 'iface.ts');
    w.st.g(webCopy, 'commit', '-q', '--no-edit');
    await answer(task, capAskOf(w)![0], ROUND_CAP_ANSWERS.more);

    // Зелёное: копия интеграции легла, MR трёх единиц, интеграция своего не открывает.
    await until(
      () =>
        [units.api, units.web, units.docs].every((id) =>
          AFTER_PUBLISH.has(task.state.units[id]!.state),
        ),
      'all three units published',
    );
    const integ = unitCopyOf(task, units.integration);
    expect(integ).toBeDefined();
    const green = Object.values(task.state.steps).filter(
      (s) =>
        s.unitId === units.integration &&
        s.stepDefId === INTEGRATION_GATE_STEP &&
        s.state === 'done',
    );
    expect(green).toHaveLength(1);
    const mrs = w.stub.state().mrs;
    expect(mrs.map((m) => m.sourceBranch).sort()).toEqual(
      [branch(units.api), branch(units.web), branch(units.docs)].sort(),
    );
    const mrOf = (id: string) => mrs.find((m) => m.sourceBranch === branch(id))!;
    expect(mrOf(units.docs).iid).toBeGreaterThan(mrOf(units.api).iid);
    for (const [self, others] of [
      ['api', ['web', 'docs']],
      ['web', ['api', 'docs']],
      ['docs', ['api', 'web']],
    ] as const) {
      const body = mrOf(units[self]).body;
      expect(body).toContain('## Related merge requests');
      for (const other of others) {
        const url = mrOf(units[other]).iid;
        expect(body).toMatch(new RegExp(`- ${other}: .*/merge_requests/${url}\\b`));
      }
      expect(body).not.toMatch(new RegExp(`- ${self}: `));
    }
    expect(mrs.some((m) => m.sourceBranch === branch(units.integration))).toBe(false);
  }, 180_000);

  it('Q-1 P135: api answers a reviewer thread with a code edit after the green integration → its republish is refused "reintegrate", a new integration round re-merges the moved head, the combined review runs again, only then the MR takes the new head', async () => {
    const w = await world({ threads: true });
    const { task, units } = w;
    const branch = (id: string) => task.state.units[id]!.branch;
    DEBUG = () =>
      JSON.stringify({
        units: Object.values(task.state.units).map((u) => [u.name, u.state]),
        steps: Object.values(task.state.steps)
          .sort((a, b) => a.startedSeq - b.startedSeq)
          .map((s) => [task.state.units[s.unitId]?.name, s.stepDefId, s.round, s.state, s.reason]),
        tail: readJournalLines(task.dir, task.taskId)
          .lines.slice(-15)
          .map((l) => [l.kind, JSON.stringify(l.data).slice(0, 300)]),
      });
    const settled = new Set(['done', 'closed', 'conditional']);
    await until(
      () => Object.values(task.state.units).every((u) => settled.has(u.state)),
      'every unit settled',
    );
    const steps = Object.values(task.state.steps).sort((a, b) => a.startedSeq - b.startedSeq);
    const of = (unitId: string, def: string) =>
      steps.filter((s) => s.unitId === unitId && s.stepDefId === def);

    // Отказ: голова api после ответа не в слиянии первого зелёного круга.
    const apiPublishes = of(units.api, 'publish');
    const refused = apiPublishes.find((s) =>
      (s.reason ?? '').startsWith('publish-refused: reintegrate:'),
    );
    expect(refused, DEBUG()).toBeDefined();
    expect(refused!.reason).toContain(branch(units.api));

    // Новый круг ворот после отказа — сдан; ревью общего диффа — снова, после него.
    const gates = of(units.integration, INTEGRATION_GATE_STEP).filter((s) => s.state === 'done');
    expect(gates.length).toBeGreaterThanOrEqual(2);
    const reround = gates.find((s) => s.startedSeq > refused!.startedSeq);
    expect(reround, DEBUG()).toBeDefined();
    const review = of(units.integration, 'integration-review').find(
      (s) => s.startedSeq > reround!.startedSeq,
    );
    expect(review?.state).toBe('done');

    // Публикация api снова — только после нового круга и его ревью, и она сдана.
    const after = apiPublishes.filter((s) => s.startedSeq > refused!.startedSeq);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.startedSeq > review!.startedSeq)).toBe(true);
    expect(after.at(-1)!.state).toBe('done');

    // Слияние интеграции содержит новую голову api; MR (ветка на «сервере») несёт её.
    const head = w.st.run(w.st.main, ['rev-parse', `refs/heads/${branch(units.api)}`]);
    const apiHead = String(head.stdout).trim();
    const integ = unitCopyOf(task, units.integration)!.dir;
    expect(w.st.run(integ, ['merge-base', '--is-ancestor', apiHead, 'HEAD']).status).toBe(0);
    const pushed = w.st.run(w.st.bare, ['rev-parse', `refs/heads/${branch(units.api)}`]);
    expect(String(pushed.stdout).trim()).toBe(apiHead);
    expect(w.st.run(integ, ['show', 'HEAD:api.ts']).stdout.toString()).toBe(ANSWER_EDIT['api.ts']);

    // Интеграция держалась открытой, пока её единицы публиковались, и кончилась после них.
    const ended = lines(task, 'unit.transition')
      .map((l) => l.data as { unitId: string; to: string })
      .filter((d) => settled.has(d.to));
    const endIdx = (id: string) => ended.findIndex((d) => d.unitId === id);
    expect(task.state.units[units.integration]!.state).toBe('done');
    for (const id of [units.api, units.web, units.docs])
      expect(endIdx(units.integration)).toBeGreaterThan(endIdx(id));
  }, 240_000);
});
