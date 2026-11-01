import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createSessionRuntime, type UserLayerTap } from '../session-runtime.ts';
import { createUserLayerTap } from './tap.ts';

/**
 * G-e, 06:121-122 — кран слоя человека через настоящий рантайм сессии и журнал: каждый
 * `hook.refused` — решение наблюдателя + сигнал `hook-block` (warn) с хуком, инструментом из
 * `tool.requested` и событием; безымянный — `unidentified user hook` с кандидатами описи.
 * Тот же отказ 3 раза за шаг — `hook-loop` (stop) → `step.stops` (проводник останавливает шаг);
 * отказы прошлого шага петлю не набирают; счёт переживает новый экземпляр крана (журнал).
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const INVENTORY: UserLayerInventory = {
  cli: 'claude',
  hash: 'h',
  sources: [],
  hooks: [
    {
      key: 'PreToolUse:Bash:guard.sh',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'guard.sh',
      sourcePath: 's',
    },
    {
      key: 'PreToolUse:*:audit.sh',
      event: 'PreToolUse',
      matcher: '*',
      command: 'audit.sh',
      sourcePath: 's',
    },
    {
      key: 'PreToolUse:Edit|Write:fmt.sh',
      event: 'PreToolUse',
      matcher: 'Edit|Write',
      command: 'fmt.sh',
      sourcePath: 's',
    },
    { key: 'Stop::stop.sh', event: 'Stop', matcher: null, command: 'stop.sh', sourcePath: 's' },
  ],
  skills: [],
  agents: [],
  unread: [],
};

const call = (toolUseId: string, command: string): AdapterEvent => ({
  type: 'tool.requested',
  toolUseId,
  name: 'Bash',
  input: { command },
  cliInitiated: false,
});

const refused = (
  toolUseId: string | null,
  hook: string | null,
  event = 'PreToolUse',
): AdapterEvent => ({
  type: 'hook.refused',
  toolUseId,
  event,
  hook,
  reason: 'blocked by policy',
  cliInitiated: false,
});

function adapterOf(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'fake',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

async function stream(
  task: LiveTask,
  sessionId: string,
  tap: UserLayerTap,
  events: AdapterEvent[],
) {
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const notes: string[] = [];
  await createSessionRuntime({ note: (event) => notes.push(event), userLayer: tap }).attach({
    task,
    binding: got.binding,
    adapter: adapterOf(events),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    resumed: false,
    onEvent: () => {},
  }).done;
  expect(notes.filter((n) => n === 'user-layer.tap.failed')).toEqual([]);
  return got.binding.stepId;
}

const signals = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'signal')
    .map((l) => ({ stepId: l.stepId, ...(l as JournalLine<'signal'>).data }));

const observerDecisions = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'decision')
    .map((l) => (l as JournalLine<'decision'>).data)
    .filter((d) => d.class === 'hook-block' || d.class === 'hook-loop');

async function freshTask() {
  const registry = createTaskRegistry(tempDir('ul-tap-'), deps());
  const task = await registry.create(CREATED);
  return { registry, task };
}

describe('G-e user layer tap (session runtime → journal)', () => {
  it('a named refusal journals an observer decision and a warn hook-block naming hook, tool and event', async () => {
    const { registry, task } = await freshTask();
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const stepId = await stream(task, sessionId, createUserLayerTap(), [
      call('t1', 'rm -rf build'),
      refused('t1', 'PreToolUse:Bash:guard.sh'),
    ]);
    expect(signals(task)).toEqual([
      {
        stepId,
        signal: 'hook-block',
        severity: 'warn',
        subject: 'PreToolUse:Bash:guard.sh',
        detail: 'Bash on PreToolUse: blocked by policy',
      },
    ]);
    const [d] = observerDecisions(task);
    // Свой класс решения у отказа хука (P01): судья класса observer — только подмена модели.
    expect(d?.class).toBe('hook-block');
    expect(d?.output).toMatchObject({ signal: 'hook-block', action: 'show', candidates: [] });
    expect(task.state.steps[stepId]?.stops).toEqual([]);
    registry.closeAll();
  });

  it('an unnamed refusal is kept as unidentified user hook with matcher candidates from the inventory', async () => {
    const { registry, task } = await freshTask();
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const tap = createUserLayerTap({ inventoryOf: () => INVENTORY });
    await stream(task, sessionId, tap, [
      call('t1', 'ls'),
      refused('t1', null),
      refused(null, null, 'Stop'),
    ]);
    expect(signals(task).map((s) => [s.subject, s.detail])).toEqual([
      ['unidentified user hook', 'Bash on PreToolUse: blocked by policy'],
      ['unidentified user hook', 'no tool call on Stop: blocked by policy'],
    ]);
    expect(
      observerDecisions(task).map((d) => (d.output as { candidates: string[] }).candidates),
    ).toEqual([['PreToolUse:Bash:guard.sh', 'PreToolUse:*:audit.sh'], ['Stop::stop.sh']]);
    registry.closeAll();
  });

  it('the same refusal 3x in one step adds a stop hook-loop that lands in step.stops; another target does not count', async () => {
    const { registry, task } = await freshTask();
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const hook = 'PreToolUse:Bash:guard.sh';
    const stepId = await stream(task, sessionId, createUserLayerTap(), [
      call('t1', 'rm -rf x'),
      refused('t1', hook),
      call('t2', 'rm -rf y'),
      refused('t2', hook),
      call('t3', 'rm -rf x'),
      refused('t3', hook),
    ]);
    expect(signals(task).map((s) => s.signal)).toEqual(['hook-block', 'hook-block', 'hook-block']);
    // Новый экземпляр крана (ядро перезапущено): счёт из журнала, третий тот же отказ — петля.
    await stream(task, sessionId, createUserLayerTap(), [
      call('t4', 'rm -rf x'),
      refused('t4', hook),
    ]);
    const got = signals(task);
    expect(got.map((s) => s.signal)).toEqual([
      'hook-block',
      'hook-block',
      'hook-block',
      'hook-block',
      'hook-loop',
    ]);
    expect(got.at(-1)).toMatchObject({ stepId, severity: 'stop', subject: hook });
    expect(task.state.steps[stepId]?.stops).toEqual([`hook-loop: ${hook}`]);
    registry.closeAll();
  });

  it('F17 the loop count reads the journal once per opened task, then counts in memory; a reopened task reads again', async () => {
    const { registry, task } = await freshTask();
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const hook = 'PreToolUse:Bash:guard.sh';
    const reads: string[] = [];
    const history = (t: LiveTask) => {
      reads.push(t.taskId);
      return readJournalLines(t.dir, t.taskId).lines;
    };
    // Два отказа до этого крана (прошлое ядро): счёт берёт их из журнала при первом отказе.
    await stream(task, sessionId, createUserLayerTap(), [
      call('t1', 'rm -rf x'),
      refused('t1', hook),
      call('t2', 'rm -rf x'),
      refused('t2', hook),
    ]);
    const tap = createUserLayerTap({ history });
    const stepId = await stream(task, sessionId, tap, [
      call('t3', 'rm -rf x'),
      refused('t3', hook),
      call('t4', 'rm -rf y'),
      refused('t4', hook),
      call('t5', 'rm -rf y'),
      refused('t5', hook),
      call('t6', 'rm -rf y'),
      refused('t6', hook),
    ]);
    expect(reads).toEqual([task.taskId]);
    // Третий `x` — петля из журнала; третий `y` — петля из счёта в памяти (журнал не перечитан).
    expect(signals(task).filter((s) => s.signal === 'hook-loop')).toHaveLength(2);
    expect(task.state.steps[stepId]?.stops).toHaveLength(2);
    // Та же задача, открытая заново (перезапуск ядра), — новый объект: счёт снова из журнала.
    const taskId = task.taskId;
    registry.closeAll();
    const again = createTaskRegistry(registry.tasksDir, deps());
    const reopened = await again.open(taskId);
    if (!('task' in reopened)) throw new Error(reopened.refused);
    await stream(reopened.task, sessionId, tap, [call('t7', 'rm -rf z'), refused('t7', hook)]);
    expect(reads).toEqual([taskId, taskId]);
    again.closeAll();
  });

  it('refusals of an earlier step never make a loop in the next step', async () => {
    const { registry, task } = await freshTask();
    const first = seedSession(task, { stepKind: 'work' });
    const hook = 'PreToolUse:Bash:guard.sh';
    const tap = createUserLayerTap();
    const s1 = await stream(task, first.sessionId, tap, [
      call('t1', 'rm -rf x'),
      refused('t1', hook),
      call('t2', 'rm -rf x'),
      refused('t2', hook),
    ]);
    const second = seedSession(task, { stepKind: 'work', unitId: first.unitId });
    const s2 = await stream(task, second.sessionId, tap, [
      call('t3', 'rm -rf x'),
      refused('t3', hook),
    ]);
    expect(s2).not.toBe(s1);
    expect(signals(task).map((s) => s.signal)).toEqual(['hook-block', 'hook-block', 'hook-block']);
    expect(task.state.steps[s2]?.stops).toEqual([]);
    registry.closeAll();
  });
});
