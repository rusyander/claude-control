import { describe, expect, it } from 'vitest';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import { randomUUID7 } from '../../core-ask/core-ask.ts';
import { TURN_ERROR_TEXT } from '../../chat/core-run/translate.ts';
import type { TestsAgentEvent } from './agent-run.types.ts';
import {
  TESTS_CORE_STOP_REASON,
  TestsCoreRun,
  testsCoreAdapterOf,
  taskEnvOf,
  testsCoreTitle,
  type TestsCoreStart,
} from './core-run.ts';
import {
  FAKE_TURN,
  fakeCorePort,
  permitAsked,
  waitFor,
  type FakeCoreOptions,
} from './__fixtures__/fake-core-port.ts';

/**
 * Агент блока «Тесты» через ядро (этап 10, F6) против управляемого ядра (`fake-core-port.ts`):
 * подменена только граница процесса ядра, прогон — настоящий `TestsCoreRun`.
 */

const start = (over: Partial<TestsCoreStart> = {}): TestsCoreStart => ({
  adapter: 'qwen',
  providerName: 'Qwen Code',
  prompt: 'Run the cases\nmore',
  cwd: 'C:/work/proj',
  title: 'Прогон: Вход',
  lang: 'ru',
  ...over,
});

async function collect(run: TestsCoreRun, options = start()): Promise<TestsAgentEvent[]> {
  const events: TestsAgentEvent[] = [];
  await run.start(options, (e) => events.push(e));
  return events;
}

const kinds = (calls: Array<{ kind: string }>): string[] => calls.map((c) => c.kind);

describe('TestsCoreRun — Tests block agent through core chat@1', () => {
  it('estimate in place with an edit grant on the project root, set-cli = provider, launch; one turn, then end-chat', async () => {
    const core = fakeCorePort({ turn: FAKE_TURN });
    const run = new TestsCoreRun({ port: core.port, pollMs: 1 });
    const events = await collect(run);
    expect(core.estimates[0]).toMatchObject({
      title: 'Прогон: Вход',
      request: 'Run the cases\nmore',
      repos: [{ path: 'C:/work/proj', baseRef: null }],
      scenario: { preset: 'chat' },
      placement: { kind: 'in-place', grant: { project: 'C:/work/proj', ops: ['edit'] } },
      lang: 'ru',
    });
    expect(kinds(core.calls)).toEqual(['set-cli', 'launch', 'end-chat']);
    expect(core.calls[0]!.fields).toMatchObject({
      scope: 'task',
      scopeId: core.taskId,
      adapter: 'qwen',
    });
    expect(core.calls[2]!.fields).toEqual({ stepId: core.stepId });
    expect(run.taskId()).toBe(core.taskId);
    expect(run.pid).toBeUndefined();
    // Лог прогона: сеанс, текст, вызов, расход, итог — мысли и итоги вызовов не его.
    expect(events.map((e) => e.kind)).toEqual(['session', 'text', 'tool', 'usage', 'done']);
    expect(events[0]).toMatchObject({ kind: 'session', sessionId: core.sessions[0] });
    expect(events[2]).toMatchObject({ kind: 'tool', name: 'Edit' });
    expect(events[4]).toMatchObject({ kind: 'done', sessionId: core.sessions[0] });
  });

  it('a core estimate refusal arrives as tests-agent-core-refused with provider and the core reason verbatim', async () => {
    const core = fakeCorePort({
      estimate: {
        ok: false,
        code: 'repo-not-git',
        message: 'C:/work/proj is not a git repository',
      },
    } as FakeCoreOptions);
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(events).toEqual([
      {
        kind: 'error',
        message:
          'Ядро не запустило прогон на Qwen Code: repo-not-git: C:/work/proj is not a git repository',
        messageCode: 'tests-agent-core-refused',
        params: {
          provider: 'Qwen Code',
          reason: 'repo-not-git: C:/work/proj is not a git repository',
        },
      },
    ]);
    expect(core.calls).toEqual([]);
  });

  it('a rejected set-cli refuses the run and cancels the placed task', async () => {
    const core = fakeCorePort({
      reject: {
        'set-cli': {
          cmdId: 'c',
          status: 'rejected',
          code: 'adapter-unknown',
          reason: 'no codex',
        } as CommandOutcome,
      },
    });
    const events = await collect(
      new TestsCoreRun({ port: core.port, pollMs: 1 }),
      start({ adapter: 'codex', providerName: 'Codex' }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'error',
      messageCode: 'tests-agent-core-refused',
      params: { provider: 'Codex', reason: 'set-cli adapter-unknown: no codex' },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(kinds(core.calls)).toEqual(['set-cli', 'cancel']);
    expect(core.calls[1]!.fields).toEqual({ reason: TESTS_CORE_STOP_REASON });
  });

  it('a step that closes without a session is a named refusal, not a hanging run', async () => {
    const core = fakeCorePort({ stepEnds: true });
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', messageCode: 'tests-agent-core-refused' });
    expect((events[0] as { message: string }).message).toContain(
      'the step ended without a session (failed): adapter refused',
    );
  });

  it('a turn that ends with an error is a refusal; the step is still closed', async () => {
    const core = fakeCorePort({ turn: [{ kind: 'turn-end', data: { isError: true } }] });
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(events.map((e) => e.kind)).toEqual(['session', 'error']);
    expect(events[1]).toMatchObject({ params: { reason: TURN_ERROR_TEXT } });
    expect(kinds(core.calls)).toContain('end-chat');
  });

  it('a turn error with the CLI words names them in the refusal, not the generic text', async () => {
    const core = fakeCorePort({
      turn: [{ kind: 'turn-end', data: { isError: true, text: 'Prompt is too long' } }],
    });
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(events[1]).toMatchObject({ kind: 'error', params: { reason: 'Prompt is too long' } });
  });

  it('a session error event is a refusal with the core detail', async () => {
    const core = fakeCorePort({
      turn: [{ kind: 'error', data: { code: 'auth', detail: 'Not logged in' } }],
    });
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(events[1]).toMatchObject({
      kind: 'error',
      params: { provider: 'Qwen Code', reason: 'Not logged in' },
    });
  });

  it('a session cut before the turn end is followed into the next session of the step', async () => {
    const core = fakeCorePort({ restart: true, turn: FAKE_TURN });
    const events = await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    const texts = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['half ', 'Гоняю кейсы.']);
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('a permit question of the run step is refused for the absent human and logged', async () => {
    const askId = randomUUID7();
    const question = 'The step needs a grant to edit ../x (Edit)';
    // Ход держится открытым, пока вопрос не отклонён; вопрос — на шаге самого прогона.
    const denies: Array<[string, string]> = [];
    const live = fakeCorePort({
      hold: true,
      journal: (stepId) => [permitAsked(stepId, askId, question)],
    });
    const run = new TestsCoreRun({
      port: live.port,
      pollMs: 1,
      onDeny: (t, m) => denies.push([t, m]),
    });
    const done = collect(run);
    await waitFor(() => live.calls.some((c) => c.kind === 'answer'));
    expect(live.calls.find((c) => c.kind === 'answer')!.fields).toEqual({
      askId,
      answer: 'refuse',
    });
    expect(denies).toEqual([
      [
        'права',
        'ядро спросило «The step needs a grant to edit ../x (Edit)» — человека у прогона нет, отказано',
      ],
    ]);
    run.stop();
    await done;
  });

  it('stop cancels the core task with the human reason and silences the run', async () => {
    const core = fakeCorePort({ hold: true, turn: FAKE_TURN });
    const run = new TestsCoreRun({ port: core.port, pollMs: 1 });
    const events: TestsAgentEvent[] = [];
    const done = run.start(start(), (e) => events.push(e));
    await waitFor(() => events.some((e) => e.kind === 'session'));
    run.stop();
    run.stop();
    await done;
    await waitFor(() => core.calls.some((c) => c.kind === 'cancel'));
    expect(core.calls.filter((c) => c.kind === 'cancel')).toEqual([
      { kind: 'cancel', fields: { reason: TESTS_CORE_STOP_REASON } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['session']);
  });

  it('adapters: claude, qwen and codex go through the core; others do not; titles are one short line', () => {
    expect(['claude', 'qwen', 'codex'].map(testsCoreAdapterOf)).toEqual([
      'claude',
      'qwen',
      'codex',
    ]);
    expect(testsCoreAdapterOf('gemini')).toBeUndefined();
    expect(testsCoreTitle('  a\n b  ')).toBe('a b');
    expect(testsCoreTitle('')).toBe('tests run');
    expect(testsCoreTitle('x'.repeat(200))).toHaveLength(80);
  });

  it('session settings, task env and contour routes reach the core: names in the estimate, values beside it, set-route before launch', async () => {
    const core = fakeCorePort({ turn: FAKE_TURN });
    const run = new TestsCoreRun({ port: core.port, pollMs: 1 });
    const routes = [
      {
        adapter: 'qwen',
        route: { kind: 'gateway' as const, id: 'gateway:corp' },
        modelPattern: 'qwen3-coder',
      },
    ];
    await collect(
      run,
      start({
        session: { scope: { edit: ['.agent/tests/**'], denyCommands: [['git', 'commit']] } },
        env: { STAND_PASSWORD: 's3cret', STAND_USER: 'qa' },
        routes,
      }),
    );
    expect(core.estimates[0]!.session).toEqual({
      scope: { edit: ['.agent/tests/**'], denyCommands: [['git', 'commit']] },
      env: ['STAND_PASSWORD', 'STAND_USER'],
    });
    // Значение секрета в поля оценки (они уходят в журнал) не попадает — только телом рядом.
    expect(JSON.stringify(core.estimates[0])).not.toContain('s3cret');
    expect(core.envs[0]).toEqual({ STAND_PASSWORD: 's3cret', STAND_USER: 'qa' });
    expect(kinds(core.calls)).toEqual(['set-cli', 'set-route', 'launch', 'end-chat']);
    expect(core.calls[1]!.fields).toEqual({
      scope: 'task',
      scopeId: core.taskId,
      allowedRoutes: routes,
    });
  });

  it('no session, env or routes: the estimate carries no session, no env body, no set-route', async () => {
    const core = fakeCorePort({ turn: FAKE_TURN });
    await collect(new TestsCoreRun({ port: core.port, pollMs: 1 }));
    expect(core.estimates[0]).not.toHaveProperty('session');
    expect(core.envs[0]).toBeUndefined();
    expect(kinds(core.calls)).toEqual(['set-cli', 'launch', 'end-chat']);
  });

  it('a caller refusal text replaces the tests-run text; stop uses the caller stop reason', async () => {
    const refusedCore = fakeCorePort({
      estimate: { ok: false, code: 'task-env-unhonoured', message: 'X is not honoured' },
    } as FakeCoreOptions);
    const events = await collect(
      new TestsCoreRun({ port: refusedCore.port, pollMs: 1 }),
      start({ refused: (reason) => ({ kind: 'error', message: `sandbox: ${reason}` }) }),
    );
    expect(events).toEqual([
      { kind: 'error', message: 'sandbox: task-env-unhonoured: X is not honoured' },
    ]);

    const core = fakeCorePort({ hold: true, turn: FAKE_TURN });
    const run = new TestsCoreRun({ port: core.port, pollMs: 1, stopReason: 'sandbox stop' });
    const seen: TestsAgentEvent[] = [];
    const done = run.start(start(), (e) => seen.push(e));
    await waitFor(() => seen.some((e) => e.kind === 'session'));
    run.stop();
    await done;
    await waitFor(() => core.calls.some((c) => c.kind === 'cancel'));
    expect(core.calls.find((c) => c.kind === 'cancel')!.fields).toEqual({ reason: 'sandbox stop' });
  });

  it('taskEnvOf keeps what the core accepts and names the rest', () => {
    const long = 'v'.repeat(32_001);
    const values: Record<string, string> = {
      STAND_USER: 'qa',
      'BAD-NAME': 'x',
      PATH: '/evil',
      node_options: '--inspect',
      AGENTDECK_TOKEN: 't',
      HUGE: long,
    };
    for (let i = 0; i < 40; i += 1) values[`V${i}`] = String(i);
    const { env, dropped } = taskEnvOf(values);
    expect(env.STAND_USER).toBe('qa');
    expect(Object.keys(env)).toHaveLength(32);
    expect(dropped.slice(0, 5)).toEqual([
      'BAD-NAME',
      'PATH',
      'node_options',
      'AGENTDECK_TOKEN',
      'HUGE',
    ]);
    expect(dropped).toHaveLength(5 + 9);
    expect(dropped).toContain('V39');
  });
});
