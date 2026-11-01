import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createSessionRuntime } from '../session-runtime.ts';
import { attachObserver } from './attach.ts';
import { createToolEventTap } from './tool-events.ts';

/**
 * Расточительство от потока до шага (этап 8, зона W): настоящий рантайм сессии с краном фактов
 * вызовов → `tool.event` в журнале → наблюдатель с реестром и каталогом ядра → `decision` класса
 * `observer` + `signal{action}`; остановка (`stop-step`) попадает в `step.stops`, подсказка — нет.
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

/**
 * Вызов инструмента в форме, которую пишет переходник Claude 2.1.310 (проба M): кода выхода в
 * структуре нет (`exitCode: null`), исход падения — текст ошибки CLI.
 */
const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  errorText: string | null = null,
): AdapterEvent[] => [
  { type: 'tool.requested', toolUseId: id, name, input, cliInitiated: false },
  {
    type: 'tool.result',
    toolUseId: id,
    isError: errorText !== null,
    cliInitiated: false,
    outcome: { exitCode: null, errorText, bytes: null },
  },
];

const bash = (id: string, command: string, exitCode = 0): AdapterEvent[] =>
  call(id, 'Bash', { command }, exitCode === 0 ? null : `Exit code ${exitCode}\nboom-to-stderr`);

async function stand() {
  const registry = createTaskRegistry(tempDir('waste-int-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const cwd = tempDir('waste-int-copy-');
  const notes: string[] = [];
  const observer = attachObserver(task, {
    ctx: { windowOf: () => null, now: () => 0 },
    note: (e) => notes.push(e),
  });
  const tap = createToolEventTap({
    sessionOf: () => ({ mapPermission: mapClaudePermission, cwd }),
    now: () => 0,
  });
  const play = async (events: AdapterEvent[]) => {
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    await createSessionRuntime({ note: (e) => notes.push(e), observer: tap }).attach({
      task,
      binding: got.binding,
      adapter: {
        id: 'fake',
        events: async function* () {
          for (const e of events) yield e;
        },
        mapPermission: mapClaudePermission,
      } as unknown as CliAdapter,
      handle: { sessionId } as SessionHandle,
      context: CONTEXT,
      onEvent: () => {},
    }).done;
    return got.binding.stepId;
  };
  const done = () => {
    observer.detach();
    registry.closeAll();
    expect(notes).toEqual([]);
  };
  return { task, cwd, play, done };
}

const signals = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l): l is JournalLine<'signal'> => l.kind === 'signal')
    .map((l) => ({ signal: l.data.signal, severity: l.data.severity, action: l.data.action }));

const observerDecisions = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId).lines.filter(
    (l) => l.kind === 'decision' && (l as JournalLine<'decision'>).data.class === 'observer',
  );

describe('stage 8 waste from the session stream to the step', () => {
  it('the same failing command three times: hint at the second, stop-step at the third, in step.stops', async () => {
    const { task, play, done } = await stand();
    const stepId = await play([
      ...bash('t1', 'node fail.js', 3),
      ...bash('t2', 'node fail.js', 3),
      ...bash('t3', 'node fail.js', 3),
    ]);
    expect(signals(task)).toEqual([
      { signal: 'waste-fail-repeat', severity: 'warn', action: 'hint' },
      { signal: 'waste-fail-repeat', severity: 'stop', action: 'stop-step' },
    ]);
    expect(observerDecisions(task)).toHaveLength(2);
    expect(task.state.steps[stepId]?.stops).toEqual(['waste-fail-repeat: node fail.js']);
    done();
  });

  it('a whole read of a 64 KiB file is a hint that never stops the step; a windowed read is silent', async () => {
    const { task, cwd, play, done } = await stand();
    writeFileSync(join(cwd, 'README.md'), 'x'.repeat(64 * 1024));
    const stepId = await play([
      ...bash('t1', 'head -n 50 README.md'),
      ...bash('t2', 'cat README.md'),
    ]);
    expect(signals(task)).toEqual([{ signal: 'waste-big-read', severity: 'warn', action: 'hint' }]);
    expect(task.state.steps[stepId]?.stops).toEqual([]);
    done();
  });

  it('four waits in a row (blocked sleep, Monitor, ScheduleWakeup, sleep chain): hint at the second, stop-step at the fourth', async () => {
    const { task, play, done } = await stand();
    const stepId = await play([
      // CLI блокирует одиночный сон ошибкой (проба M) — это опрос, а не падение команды.
      ...call(
        't1',
        'Bash',
        { command: 'sleep 30' },
        '<tool_use_error>Blocked: standalone sleep 30. Use Monitor or run_in_background.</tool_use_error>',
      ),
      ...call('t2', 'Monitor', { command: 'until [ -f done ]; do sleep 2; done' }),
      ...call('t3', 'ScheduleWakeup', { delaySeconds: 60 }),
      ...bash('t4', 'sleep 21 && echo after'),
    ]);
    expect(signals(task)).toEqual([
      { signal: 'waste-poll', severity: 'warn', action: 'hint' },
      { signal: 'waste-poll', severity: 'stop', action: 'stop-step' },
    ]);
    expect(task.state.steps[stepId]?.stops).toEqual(['waste-poll: sleep 21 && echo after']);
    done();
  });
});
