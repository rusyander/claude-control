import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { IntakeSource } from '@agentdeck/contracts/core/intake';
import type { TaskListItem, TaskReply } from '@agentdeck/contracts/core/panel-api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import { copyWiring } from '../../bootstrap/copy-wiring.ts';
import { unitViewOf } from '../../bootstrap/publish-wiring/unit-view.ts';
import { installer, PROFILE } from '../copy/__fixtures__/copy-harness.ts';
import { unitCopyOf } from '../copy/index.ts';
import { REQUEST_ARTIFACT } from '../estimate/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { INTEGRATION_ROLE } from '../gates/index.ts';
import { GROUP_MIXED_PROBLEM } from '../intake/index.ts';
import { raiseHumanPoint } from '../human/raise.ts';
import { decideNext } from '../next/next.ts';
import { FakePort } from '../run/__fixtures__/run-harness.ts';
import { taskMove } from '../run/moves.ts';
import { runTask } from '../run/run.ts';
import type { RunHandle } from '../run/run.types.ts';
import { presetOf } from '../scenario/index.ts';
import { estimateBody, g, gitRepo, testEnv, type TestEnv } from './__fixtures__/split-stand.ts';
import {
  afterAccept,
  createChildTasks,
  deliverableOf,
  proposeSplit,
  XL_CHILDREN_SIGNAL,
  XL_POLL_MS,
  xlChildrenPort,
  type ProposedUnit,
} from './index.ts';

/**
 * Группа = тот же алгоритм и дети XL (этап 11, W3-18, D18) на настоящей ручке оценки и настоящем
 * запуске деления: `sources` пунктов группы — N задач с общим `groupId` (список и вид их
 * называют), XL — дочерние задачи с `parentTaskId` через тот же запуск деления; L с параллельными
 * единицами — единица интеграции после всех них (W3-18b).
 */

let root: string;
let stand: Stand;
let env: TestEnv;

const FILES = { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'core-group-'));
  stand = await startStand();
  env = testEnv(stand.layout.scenarios);
  env.childTasks = (parent, splitId, units, only) =>
    createChildTasks(stand.registry, env, parent, splitId, units, only);
  stand.setSplit(env);
});
afterAll(async () => {
  await stand.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const item = (key: string): IntakeSource => ({
  kind: 'group-item',
  key,
  title: `Ticket ${key}`,
  body: `Do ${key}.`,
  acceptance: [`${key} is done`],
  fetchedAt: 1,
  digest: key
    .toLowerCase()
    .padEnd(64, '0')
    .replace(/[^0-9a-f]/g, 'a'),
});

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { nonce, page } = await stand.nonce();
  const res = await fetch(`${stand.url}/v1/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
    body: JSON.stringify({ ...(body as object), proof: { nonce, page } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${stand.url}${path}`, {
    headers: { authorization: `Bearer ${TOKENS.core}` },
  });
  return (await res.json()) as T;
}

const lines = (task: LiveTask) => readJournalLines(task.dir, task.taskId).lines;

describe('W3-18 group = the same algorithm', () => {
  it('sources of 3 group items → 3 lead tasks with one groupId; the list filter and the view name it; a replay names the same group', async () => {
    const repo = gitRepo(root, 'group3', FILES);
    const body = estimateBody([repo], {
      scenario: { preset: 'lead' },
      sources: [item('PROJ-1'), item('PROJ-2'), item('PROJ-3')],
    });
    const out = await post(body);
    expect(out.status).toBe(202);
    const reply = out.body as unknown as EstimateReply;
    expect(reply.group?.taskIds).toHaveLength(3);
    expect(reply.taskId).toBe(reply.group?.taskIds[0]);
    const groupId = reply.group!.groupId;
    for (const [i, taskId] of reply.group!.taskIds.entries()) {
      const task = stand.registry.live(taskId)!;
      expect(task.state.created?.groupId).toBe(groupId);
      expect(task.state.created?.title).toBe(`Ticket PROJ-${i + 1}`);
      expect(task.state.task).toBe('estimating');
      // Каждая — свой приём: одна строка критерия своего пункта, не трёх.
      const rows = lines(task).filter((l) => l.kind === 'requirement.extracted');
      expect(rows.map((l) => (l.data as { text: string }).text)).toEqual([`PROJ-${i + 1} is done`]);
    }
    const listed = await get<{ tasks: TaskListItem[] }>(`/v1/tasks?groupId=${groupId}`);
    expect(listed.tasks.map((t) => t.taskId).sort()).toEqual([...reply.group!.taskIds].sort());
    expect(listed.tasks.every((t) => t.groupId === groupId)).toBe(true);
    const view = await get<TaskReply>(`/v1/tasks/${reply.group!.taskIds[1]}`);
    expect(view.view.groupId).toBe(groupId);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect((again.body as unknown as EstimateReply).group).toEqual(reply.group);
    expect(
      (await get<{ tasks: TaskListItem[] }>(`/v1/tasks?groupId=${groupId}`)).tasks,
    ).toHaveLength(3);
  });

  it('a group launch cut after its first task (crash) → the retry with the same cmdId creates the missing tasks, not a group of one', async () => {
    const repo = gitRepo(root, 'group-half', FILES);
    const body = estimateBody([repo], {
      scenario: { preset: 'lead' },
      sources: [item('PROJ-4'), item('PROJ-5'), item('PROJ-6')],
    });
    // Журнал после краха между задачами: задача пункта 0 под тем же `cmdId` и группой, двух нет.
    const cut = await post({ ...body, fields: { ...body.fields, sources: [item('PROJ-4')] } });
    expect(cut.status).toBe(202);
    const groupId = (cut.body as unknown as EstimateReply).group!.groupId;
    const again = await post(body);
    expect(again.status).toBe(200);
    const reply = again.body as unknown as EstimateReply;
    expect(reply.taskId).toBe((cut.body as unknown as EstimateReply).taskId);
    expect(reply.group?.groupId).toBe(groupId);
    expect(reply.group?.taskIds).toHaveLength(3);
    const titles = reply.group!.taskIds.map((id) => stand.registry.live(id)!.state.created?.title);
    expect(titles).toEqual(['Ticket PROJ-4', 'Ticket PROJ-5', 'Ticket PROJ-6']);
    // Третий повтор — чистый повтор: та же группа, ни одной новой задачи.
    const third = await post(body);
    expect(third.status).toBe(200);
    expect((third.body as unknown as EstimateReply).group).toEqual(reply.group);
  });

  it('F-06 a group cut after its first task whose XL split already launched children → the retry still creates the missing item task; children are never group items (reply, list)', async () => {
    const repo = gitRepo(root, 'group-xl-cut', FILES);
    const body = estimateBody([repo], {
      scenario: { preset: 'lead' },
      sources: [item('PROJ-20'), item('PROJ-21')],
      launchPolicy: 'auto',
    });
    // Крах после задачи пункта 0: она уже XL и запустила деление — двое детей с её `groupId`.
    const cut = await post({ ...body, fields: { ...body.fields, sources: [item('PROJ-20')] } });
    expect(cut.status).toBe(202);
    const first = cut.body as unknown as EstimateReply;
    const parent = stand.registry.live(first.taskId)!;
    parent.append({
      kind: 'decision',
      actor: 'core',
      data: {
        decisionId: newId(),
        class: 'classify',
        inputs: [],
        facts: [],
        numbers: {},
        reasons: [],
        output: { class: 'XL' },
      },
    });
    await launched(parent, [unit(parent, 'api', 'src/a.ts'), unit(parent, 'web', 'src/b.ts')]);
    const children = stand.registry
      .list()
      .filter((s) => stand.registry.view(s.taskId)?.created?.parentTaskId === parent.taskId);
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (c) => stand.registry.view(c.taskId)?.created?.groupId === first.group!.groupId,
      ),
    ).toBe(true);
    // Повтор с полным телом: дети не считаются пунктами — недостающий PROJ-21 досоздан.
    const again = await post(body);
    expect(again.status).toBe(200);
    const reply = again.body as unknown as EstimateReply;
    expect(reply.group?.taskIds).toHaveLength(2);
    const titles = reply.group!.taskIds.map((id) => stand.registry.live(id)!.state.created?.title);
    expect(titles).toEqual(['Ticket PROJ-20', 'Ticket PROJ-21']);
    const listed = await get<{ tasks: TaskListItem[] }>(
      `/v1/tasks?groupId=${first.group!.groupId}`,
    );
    expect(listed.tasks.map((t) => t.taskId).sort()).toEqual([...reply.group!.taskIds].sort());
  });

  it('group items mixed with a tracker source → 422 named, no task', async () => {
    const repo = gitRepo(root, 'mixed', FILES);
    const before = stand.registry.list().length;
    const tracker: IntakeSource = { ...item('PROJ-9'), kind: 'tracker' };
    const out = await post(
      estimateBody([repo], { scenario: { preset: 'lead' }, sources: [item('PROJ-8'), tracker] }),
    );
    expect(out.status).toBe(422);
    expect(JSON.stringify(out.body)).toContain(GROUP_MIXED_PROBLEM);
    expect(stand.registry.list().length).toBe(before);
  });
});

/** Задача ведущего на оценке, класс — решением `classify`, как пишет классификатор. */
async function ledTask(name: string, cls: 'M' | 'L' | 'XL'): Promise<LiveTask> {
  const repo = gitRepo(root, name, FILES);
  const out = await post(
    estimateBody([repo], {
      scenario: { preset: 'lead' },
      source: { kind: 'text', body: 'Do the goal.', fetchedAt: 1, digest: 'd'.repeat(64) },
      launchPolicy: 'auto',
    }),
  );
  if (out.status !== 202) throw new Error(`estimate ${out.status}: ${JSON.stringify(out.body)}`);
  const task = stand.registry.live((out.body as unknown as EstimateReply).taskId)!;
  task.append({
    kind: 'decision',
    actor: 'core',
    data: {
      decisionId: newId(),
      class: 'classify',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [],
      output: { class: cls },
    },
  });
  return task;
}

const unit = (task: LiveTask, name: string, path: string, deps: string[] = []): ProposedUnit => ({
  name,
  repoKey: task.state.created!.repos[0]!.repoKey,
  ownedPaths: [path],
  deps,
  contract: false,
  estimate: { minutes: null, tokens: null },
});

async function launched(task: LiveTask, units: ProposedUnit[]) {
  const outcome = proposeSplit(
    task,
    units,
    { by: 'plan', stepId: null },
    { deliverable: deliverableOf('lead', null) },
    env,
  );
  expect(outcome.decision.verdict).toBe('accepted');
  return afterAccept(task, outcome, env);
}

describe('W3-18 XL single goal → child tasks through the split launch', () => {
  it('an accepted XL split of 2 parts launches 2 child tasks with parentTaskId; the parent makes no unit and finishes', async () => {
    const parent = await ledTask('xl', 'XL');
    const after = await launched(parent, [
      unit(parent, 'api', 'src/a.ts'),
      unit(parent, 'web', 'src/b.ts'),
    ]);
    expect(after).toMatchObject({ kind: 'launched', units: [] });
    const signal = lines(parent).find(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === XL_CHILDREN_SIGNAL,
    );
    const children = JSON.parse((signal!.data as { detail: string }).detail) as {
      taskIds: string[];
    };
    expect(children.taskIds).toHaveLength(2);
    for (const id of children.taskIds) {
      const child = stand.registry.live(id)!;
      expect(child.state.created?.parentTaskId).toBe(parent.taskId);
      expect(child.state.created?.groupId).toBe(`xl-${parent.taskId}`);
      expect(child.state.created?.lead).toBeDefined();
      expect(child.state.task).toBe('estimating');
    }
    // Строка списка несёт родителя (W3-18): фильтр `parentTaskId` списка задач находит детей.
    const byParent = await get<{ tasks: TaskListItem[] }>(
      `/v1/tasks?parentTaskId=${parent.taskId}`,
    );
    expect(byParent.tasks.map((t) => t.taskId).sort()).toEqual([...children.taskIds].sort());
    expect(Object.values(parent.state.units).every((u) => u.splitId === null)).toBe(true);
    // Q-2 s11: на запуске родитель не кончается — суд с детьми из журналов ждёт их.
    const scenario = presetOf({ id: 'lead', version: 1 })!;
    const port = xlChildrenPort({ registry: stand.registry, childTasks: env.childTasks! });
    const xl = port.childrenOf(parent)!;
    expect(xl.children.map((c) => [c.name, c.ended])).toEqual([
      ['api', null],
      ['web', null],
    ]);
    const action = decideNext({
      state: parent.state,
      scenario,
      workNowMs: 0,
      nowMs: 1000,
      live: {},
      children: xl,
    }).action;
    expect(action).toMatchObject({ kind: 'wait', untilWallMs: 1000 + XL_POLL_MS });
    const listed = await get<{ tasks: TaskListItem[] }>(`/v1/tasks?parentTaskId=${parent.taskId}`);
    expect(listed.tasks.map((t) => t.taskId).sort()).toEqual([...children.taskIds].sort());
    // N-1: строка списка без фильтра несёт те же поля связи, что и с фильтром.
    const plain = await get<{ tasks: TaskListItem[] }>('/v1/tasks');
    const row = plain.tasks.find((t) => t.taskId === children.taskIds[0]);
    expect(row).toMatchObject({ parentTaskId: parent.taskId, groupId: `xl-${parent.taskId}` });
    expect(plain.tasks.find((t) => t.taskId === parent.taskId)?.parentTaskId).toBeUndefined();
    const view = await get<TaskReply>(`/v1/tasks/${children.taskIds[0]}`);
    expect(view.view.parentTaskId).toBe(parent.taskId);
  });

  it('an L split of the same 2 parts stays units of one task (no child task)', async () => {
    const task = await ledTask('l-units', 'L');
    const before = stand.registry.list().length;
    await launched(task, [unit(task, 'api', 'src/a.ts'), unit(task, 'web', 'src/b.ts')]);
    expect(stand.registry.list().length).toBe(before);
    expect(Object.values(task.state.units).filter((u) => u.splitId !== null).length).toBe(3);
  });
});

/**
 * Q-2 s11: родитель XL ведёт настоящий исполнитель (`runTask`) с настоящим портом детей поверх
 * журналов; дети создаются настоящей оценкой. Подменён только ход самих детей: их конец пишет
 * `taskMove` (как их исполнитель), а провал — решение `fail-task` с причиной перед ним.
 */
describe('Q-2 XL parent waits for its children', () => {
  const runs: RunHandle[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await r.stop();
  });

  function drive(parent: LiveTask): RunHandle {
    const run = runTask(parent, {
      hooks: [],
      scenarioOf: (ref) => presetOf(ref),
      sessions: Object.assign(new FakePort({}), { task: parent }),
      raise: (r) => raiseHumanPoint(parent, r),
      now: () => Date.now(),
      xl: xlChildrenPort({ registry: stand.registry, childTasks: env.childTasks!, pollMs: 20 }),
    });
    runs.push(run);
    return run;
  }

  const childOf = (parent: LiveTask, name: string): LiveTask | undefined =>
    stand.registry
      .liveTasks()
      .find(
        (t) =>
          t.state.created?.parentTaskId === parent.taskId &&
          t.state.created.title.endsWith(` · ${name}`),
      );

  function endChild(child: LiveTask, outcome: 'done' | 'failed', why = ''): void {
    // Ребёнок прошёл свою оценку и запуск (estimating → awaiting-launch → running), как в ядре.
    taskMove(child, 'estimated');
    taskMove(child, 'launch');
    if (outcome === 'failed') {
      child.append({
        kind: 'decision',
        actor: 'core',
        data: {
          decisionId: newId(),
          class: 'next',
          inputs: [],
          facts: [],
          numbers: {},
          reasons: ['fail-task', why],
          output: { kind: 'fail-task', reason: why },
        },
      });
    }
    taskMove(child, outcome === 'done' ? 'finish' : 'fail');
    expect(child.state.ended).toBe(outcome);
  }

  const parentDecisions = (parent: LiveTask) =>
    lines(parent)
      .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'next')
      .map(
        (l) =>
          (l.data as unknown as { output: { kind: string; names?: string[]; reason?: string } })
            .output,
      );

  // Копии детей — настоящий вход дирижёра (`copyWiring.prepare`); подменён только установщик.
  const copies = () =>
    copyWiring({
      registry: { live: (id) => stand.registry.live(id) },
      layout: { logs: join(root, 'logs') },
      profileOf: async () => PROFILE,
      root: join(root, 'copies'),
      install: installer().install,
      env: async () => ({ PATH: process.env.PATH ?? '' }),
    });
  const unitZero = (child: LiveTask): string => Object.keys(child.state.units)[0]!;

  /** Копия единицы 0 ребёнка по настоящему пути; ответ — её каталог. */
  async function layCopy(child: LiveTask): Promise<string> {
    const laid = await copies().prepare(child.taskId, unitZero(child));
    if (!('value' in laid)) throw new Error(`copy of ${child.taskId}: ${JSON.stringify(laid)}`);
    return unitCopyOf(child, unitZero(child))!.dir;
  }

  /** Работа ребёнка в его копии (как сеанс): файлы и коммит на ветке единицы; ответ — голова. */
  async function workIn(child: LiveTask, files: Record<string, string>): Promise<string> {
    const dir = await layCopy(child);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    g(dir, 'add', '--', ...Object.keys(files));
    g(dir, 'commit', '-q', '-m', `work of ${child.state.created!.title}`);
    return g(dir, 'rev-parse', 'HEAD');
  }

  async function until(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`until: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('web depends on api → only api is created at launch; the parent waits (no finish), web is created only after api is done, the parent finishes done after web', async () => {
    const parent = await ledTask('xl-deps', 'XL');
    await launched(parent, [
      unit(parent, 'api', 'src/a.ts'),
      unit(parent, 'web', 'src/b.ts', ['api']),
    ]);
    const api = childOf(parent, 'api')!;
    expect(api).toBeDefined();
    expect(childOf(parent, 'web')).toBeUndefined();
    drive(parent);
    // Двадцать с лишним опросов: родитель ждёт, web не создан, конца нет.
    await new Promise((r) => setTimeout(r, 500));
    expect(parent.state.ended).toBeNull();
    expect(childOf(parent, 'web')).toBeUndefined();
    expect(parentDecisions(parent).map((o) => o.kind)).not.toContain('finish-task');

    await workIn(api, { 'src/a.ts': 'export const a = 2;\n' });
    endChild(api, 'done');
    await until(() => childOf(parent, 'web') !== undefined, 'web created after api done');
    const web = childOf(parent, 'web')!;
    expect(web.state.created?.parentTaskId).toBe(parent.taskId);
    expect(parentDecisions(parent)).toContainEqual({ kind: 'launch-children', names: ['web'] });
    expect(parent.state.ended).toBeNull();

    endChild(web, 'done');
    await until(() => parent.state.ended !== null, 'parent ended');
    expect(parent.state.ended).toBe('done');
    expect(parentDecisions(parent).at(-1)).toEqual({ kind: 'finish-task' });
  }, 60_000);

  it('a child refused at creation (its repository is gone when its wave comes) → the parent fails naming the refused child and why, never finishes green', async () => {
    const parent = await ledTask('xl-refused', 'XL');
    await launched(parent, [
      unit(parent, 'api', 'src/a.ts'),
      unit(parent, 'web', 'src/b.ts', ['api']),
    ]);
    const api = childOf(parent, 'api')!;
    expect(api).toBeDefined();
    drive(parent);
    await new Promise((r) => setTimeout(r, 300));
    expect(parent.state.ended).toBeNull();

    // Репозиторий исчез между волнами: оценка ребёнка web отказывает (422), задачи нет.
    const repo = parent.state.created!.repos[0]!.path;
    renameSync(repo, `${repo}-gone`);
    endChild(api, 'done');
    await until(() => parent.state.ended !== null, 'parent ended');
    expect(parent.state.ended).toBe('failed');
    expect(childOf(parent, 'web')).toBeUndefined();
    expect(parentDecisions(parent)).toContainEqual({ kind: 'launch-children', names: ['web'] });
    const last = parentDecisions(parent).at(-1)!;
    expect(last.kind).toBe('fail-task');
    expect(last.reason).toMatch(/^child web refused at creation: .+/);
  }, 60_000);

  it('the dependency fails → its dependent is never created; the parent fails naming the failed child with its reason and the never-started one', async () => {
    const parent = await ledTask('xl-dep-failed', 'XL');
    await launched(parent, [
      unit(parent, 'api', 'src/a.ts'),
      unit(parent, 'web', 'src/b.ts', ['api']),
    ]);
    const api = childOf(parent, 'api')!;
    drive(parent);
    endChild(api, 'failed', 'unit u1: tests red');
    await until(() => parent.state.ended !== null, 'parent ended');
    expect(parent.state.ended).toBe('failed');
    expect(childOf(parent, 'web')).toBeUndefined();
    const reason = parentDecisions(parent).at(-1)!.reason!;
    expect(reason).toContain(`child api (${api.taskId}) failed: unit u1: tests red`);
    expect(reason).toContain('child web never started: its dependencies api did not finish done');
  }, 60_000);

  it("a dependent child is based on its dependency's published head: web (after api, needs api's src/client.ts) is created on api's head, its copy has api's file, its MR still targets main", async () => {
    const parent = await ledTask('xl-dep-base', 'XL');
    await launched(parent, [
      unit(parent, 'api', 'src/client.ts'),
      unit(parent, 'web', 'src/b.ts', ['api']),
    ]);
    const api = childOf(parent, 'api')!;
    const parentBase = parent.state.created!.repos[0]!.baseRef;
    const apiHead = await workIn(api, { 'src/client.ts': 'export const client = "api";\n' });
    drive(parent);
    endChild(api, 'done');
    await until(() => childOf(parent, 'web') !== undefined, 'web created after api done');
    const web = childOf(parent, 'web')!;
    const request = readFileSync(join(web.dir, REQUEST_ARTIFACT), 'utf8');
    expect(request).toContain('after: api');
    expect(web.state.created!.repos[0]!.baseRef).toBe(apiHead);
    expect(apiHead).not.toBe(parentBase);
    const webDir = await layCopy(web);
    expect(g(webDir, 'rev-parse', 'HEAD')).toBe(apiHead);
    expect(readFileSync(join(webDir, 'src/client.ts'), 'utf8')).toBe(
      'export const client = "api";\n',
    );
    // Цель MR — как у единиц одной задачи с зависимостями: основная ветка, не голова api и не sha.
    for (const child of [api, web]) {
      const view = await unitViewOf(child, unitZero(child));
      expect(view).toMatchObject({ value: { baseBranch: 'main', remote: 'origin' } });
    }
    endChild(web, 'done');
    await until(() => parent.state.ended !== null, 'parent ended');
    expect(parent.state.ended).toBe('done');
  }, 120_000);

  it('a child after two dependencies is based on the merge of both heads; heads that conflict → the child is never created and the parent fails naming it and the conflict', async () => {
    const clean = await ledTask('xl-two-deps', 'XL');
    await launched(clean, [
      unit(clean, 'api', 'src/client.ts'),
      unit(clean, 'lib', 'src/lib.ts'),
      unit(clean, 'web', 'src/b.ts', ['api', 'lib']),
    ]);
    const heads = [
      await workIn(childOf(clean, 'api')!, { 'src/client.ts': 'export const client = 1;\n' }),
      await workIn(childOf(clean, 'lib')!, { 'src/lib.ts': 'export const lib = 1;\n' }),
    ];
    drive(clean);
    endChild(childOf(clean, 'api')!, 'done');
    endChild(childOf(clean, 'lib')!, 'done');
    await until(() => childOf(clean, 'web') !== undefined, 'web created after both deps');
    const web = childOf(clean, 'web')!;
    const base = web.state.created!.repos[0]!.baseRef;
    const repo = clean.state.created!.repos[0]!.path;
    expect(g(repo, 'rev-list', '--parents', '-n', '1', base).split(' ').slice(1)).toEqual(heads);
    const webDir = await layCopy(web);
    expect(readFileSync(join(webDir, 'src/client.ts'), 'utf8')).toBe('export const client = 1;\n');
    expect(readFileSync(join(webDir, 'src/lib.ts'), 'utf8')).toBe('export const lib = 1;\n');

    const clash = await ledTask('xl-deps-clash', 'XL');
    await launched(clash, [
      unit(clash, 'api', 'src/client.ts'),
      unit(clash, 'lib', 'src/lib.ts'),
      unit(clash, 'web', 'src/b.ts', ['api', 'lib']),
    ]);
    await workIn(childOf(clash, 'api')!, { 'src/a.ts': 'export const a = "api";\n' });
    await workIn(childOf(clash, 'lib')!, { 'src/a.ts': 'export const a = "lib";\n' });
    drive(clash);
    endChild(childOf(clash, 'api')!, 'done');
    endChild(childOf(clash, 'lib')!, 'done');
    await until(() => clash.state.ended !== null, 'parent ended');
    expect(clash.state.ended).toBe('failed');
    expect(childOf(clash, 'web')).toBeUndefined();
    expect(parentDecisions(clash)).toContainEqual({ kind: 'launch-children', names: ['web'] });
    const last = parentDecisions(clash).at(-1)!;
    expect(last.kind).toBe('fail-task');
    expect(last.reason).toMatch(
      /^child web refused at creation: dependency heads conflict: src\/a\.ts \(agentdeck\/\S+ \+ agentdeck\/\S+\)/,
    );
  }, 120_000);
});

describe('W3-18b integration unit at the split launch', () => {
  it('L with 2 parallel units → an integration unit, role integrate, after both, no owned paths', async () => {
    const task = await ledTask('l-parallel', 'L');
    await launched(task, [unit(task, 'api', 'src/a.ts'), unit(task, 'web', 'src/b.ts')]);
    const parts = Object.entries(task.state.units).filter(([, u]) => u.splitId !== null);
    const integ = parts.filter(([, u]) => u.role === INTEGRATION_ROLE);
    expect(integ).toHaveLength(1);
    const [, iu] = integ[0]!;
    expect(iu.name).toBe('integration');
    expect(iu.ownedPaths).toEqual([]);
    const others = parts.filter(([, u]) => u.role !== INTEGRATION_ROLE).map(([id]) => id);
    expect([...iu.after].sort()).toEqual([...others].sort());
  });

  it('a chain (web after api) and an M task get no integration unit', async () => {
    const chain = await ledTask('l-chain', 'L');
    await launched(chain, [
      unit(chain, 'api', 'src/a.ts'),
      unit(chain, 'web', 'src/b.ts', ['api']),
    ]);
    expect(Object.values(chain.state.units).some((u) => u.role === INTEGRATION_ROLE)).toBe(false);
    const m = await ledTask('m-parallel', 'M');
    await launched(m, [unit(m, 'api', 'src/a.ts'), unit(m, 'web', 'src/b.ts')]);
    expect(Object.values(m.state.units).some((u) => u.role === INTEGRATION_ROLE)).toBe(false);
  });
});
