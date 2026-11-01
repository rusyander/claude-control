import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/adapter.types.ts';
import { mapQwenPermission } from '../../adapters/qwen/permission.ts';
import { SdkNormaliser } from '../../adapters/sdk-stream/normalise.ts';
import { SDK_PERMIT_CODEC, SDK_TOOL_PROXIES } from '../../adapters/sdk-stream/permit-codec.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { answerPermitCall, FORGED_AUTHORITY } from '../../conductor/model-tools/permit-call.ts';
import { openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { createPendingPermits, PENDING_LIMIT } from './pending.ts';

/**
 * Ворот права (R:S3-09, P41) и прокси отложенных инструментов. Qwen Code зовёт отложенный
 * инструмент MCP через `tool_call {name, arguments}`: поток пишет запрос `tool_call`, а вопрос
 * `can_use_tool` называет цель. Законен вопрос ровно о цели; любой другой — подделка.
 */

const SELF = 'mcp__agentdeck-permit__approve';
const STEP_DONE = 'mcp__agentdeck__step_done';
const S = 'session-1';

const requested = (toolUseId: string, name: string, input: unknown = {}): AdapterEvent => ({
  type: 'tool.requested',
  toolUseId,
  name,
  input,
  cliInitiated: false,
});
const proxyCall = (toolUseId: string, target: unknown): AdapterEvent =>
  requested(toolUseId, 'tool_call', { name: target, arguments: { a: 1 } });

describe('pending permits — the deferred-tool proxy', () => {
  it('the SDK proxy list is the one the gate uses by default', () => {
    expect(SDK_TOOL_PROXIES).toEqual(['tool_call']);
  });

  it('a pending proxy call matches a question about its target, once', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, proxyCall('c1', STEP_DONE));
    expect(await gate.claim(S, 'c1', STEP_DONE, 10)).toEqual({ pending: true });
    expect(await gate.claim(S, 'c1', STEP_DONE, 10)).toEqual({
      pending: false,
      reason: 'request already answered',
    });
  });

  it('the CLI resolves the target name without case: the question about the registered name matches', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, proxyCall('c1', 'MCP__AgentDeck__Step_Done'));
    expect(await gate.claim(S, 'c1', STEP_DONE, 10)).toEqual({ pending: true });
  });

  it('a question about another tool, or about the proxy itself, stays refused', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, proxyCall('c1', STEP_DONE));
    expect(await gate.claim(S, 'c1', 'run_shell_command', 10)).toEqual({
      pending: false,
      reason: `pending tool is tool_call → ${STEP_DONE}, not run_shell_command`,
    });
    expect((await gate.claim(S, 'c1', 'tool_call', 10)).pending).toBe(false);
    // Отказ не тратит запрос: законный вопрос после подделки всё ещё отвечает.
    expect(await gate.claim(S, 'c1', STEP_DONE, 10)).toEqual({ pending: true });
  });

  it('a proxy without a target name answers no question', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, requested('c1', 'tool_call', { arguments: {} }));
    gate.observe(S, requested('c2', 'tool_call', { name: '' }));
    gate.observe(S, requested('c3', 'tool_call', ['x']));
    gate.observe(S, requested('c4', 'tool_call', null));
    gate.observe(S, requested('c5', 'tool_call', 'x'));
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      for (const tool of ['tool_call', STEP_DONE]) {
        expect(await gate.claim(S, id, tool, 10)).toEqual({
          pending: false,
          reason: 'pending proxy tool_call names no tool',
        });
      }
    }
  });

  it('a proxy aimed at the permission server is the self-call forgery, in any case', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, proxyCall('c1', SELF.toUpperCase()));
    expect(await gate.claim(S, 'c1', SELF, 10)).toEqual({
      pending: false,
      reason: 'the permission server itself was called as a tool',
    });
    // Имя сервера права в смешанном регистре: сравнение без регистра с обеих сторон.
    const mixed = createPendingPermits({ selfToolNames: ['mcp__Permit__Approve'] });
    mixed.observe(S, proxyCall('c2', 'mcp__permit__approve'));
    expect(await mixed.claim(S, 'c2', 'mcp__permit__approve', 10)).toEqual({
      pending: false,
      reason: 'the permission server itself was called as a tool',
    });
  });

  it('only a declared proxy unwraps: an ordinary call with a name field keeps its own name', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, requested('c1', 'read_file', { name: 'run_shell_command' }));
    expect((await gate.claim(S, 'c1', 'run_shell_command', 10)).pending).toBe(false);
    expect(await gate.claim(S, 'c1', 'read_file', 10)).toEqual({ pending: true });
    // Свой список прокси заменяет список по умолчанию.
    const own = createPendingPermits({ selfToolNames: [SELF], proxyToolNames: ['bridge'] });
    own.observe(S, proxyCall('c2', STEP_DONE));
    expect((await own.claim(S, 'c2', STEP_DONE, 10)).pending).toBe(false);
    own.observe(S, requested('c3', 'bridge', { name: STEP_DONE }));
    expect(await own.claim(S, 'c3', STEP_DONE, 10)).toEqual({ pending: true });
  });

  it('a finished proxy call answers no question; a late request wakes the waiting claim', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, proxyCall('c1', STEP_DONE));
    gate.observe(S, { type: 'tool.result', toolUseId: 'c1', isError: false, cliInitiated: false });
    expect(await gate.claim(S, 'c1', STEP_DONE, 10)).toEqual({
      pending: false,
      reason: 'tool call already finished',
    });
    const waiting = gate.claim(S, 'c2', STEP_DONE, 2_000);
    gate.observe(S, proxyCall('c2', STEP_DONE));
    expect(await waiting).toEqual({ pending: true });
    expect(PENDING_LIMIT).toBeGreaterThan(0);
  });
});

describe('pending permits — limits, case and forgetting (core-s2 F-92)', () => {
  it('over the limit, finished calls leave first: an open request survives', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, requested('open', STEP_DONE));
    for (let i = 0; i < PENDING_LIMIT + 5; i++) {
      gate.observe(S, requested(`done-${i}`, 'Read'));
      gate.observe(S, {
        type: 'tool.result',
        toolUseId: `done-${i}`,
        isError: false,
        cliInitiated: false,
      });
    }
    expect(await gate.claim(S, 'open', STEP_DONE, 10)).toEqual({ pending: true });
  });

  it('the permission server called under another case is still the self-call forgery', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    gate.observe(S, requested('c1', SELF.toUpperCase()));
    expect(await gate.claim(S, 'c1', SELF.toUpperCase(), 10)).toMatchObject({
      pending: false,
      reason: 'the permission server itself was called as a tool',
    });
  });

  it('forget answers a waiting claim at once instead of leaving it to its timer', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    const started = Date.now();
    const waiting = gate.claim(S, 'never', STEP_DONE, 5_000);
    gate.forget(S);
    expect(await waiting).toMatchObject({ pending: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stage 8 deciding: true only while a question waits for its stream request — not for an answered or claimed call (stall watch input)', async () => {
    const gate = createPendingPermits({ selfToolNames: [SELF] });
    expect(gate.deciding(S)).toBe(false);
    // Вопрос раньше запроса потока: ядро решает — тишина сессии не зависание.
    const waiting = gate.claim(S, 'c1', STEP_DONE, 5_000);
    expect(gate.deciding(S)).toBe(true);
    expect(gate.deciding('other-session')).toBe(false);
    gate.observe(S, requested('c1', STEP_DONE));
    expect(await waiting).toEqual({ pending: true });
    // Near-miss: `claimed` держится до `tool.result` — исполнение разрешённого не «решение».
    expect(gate.deciding(S)).toBe(false);
    // Ожидание, кончившееся таймером или забытой сессией, тоже снимает признак.
    const timed = gate.claim(S, 'never', STEP_DONE, 5);
    expect(gate.deciding(S)).toBe(true);
    await timed;
    expect(gate.deciding(S)).toBe(false);
    const forgotten = gate.claim(S, 'never2', STEP_DONE, 5_000);
    gate.forget(S);
    await forgotten;
    expect(gate.deciding(S)).toBe(false);
  });
});

/** Кадры настоящего Qwen Code 0.24.3 (поток сеанса e2e, 28.10), сокращены до значимых полей. */
const ASSISTANT_FRAME = JSON.stringify({
  type: 'assistant',
  session_id: '0a38103d-e1db-4b97-a3c3-f2213a5012bf',
  parent_tool_use_id: null,
  message: {
    id: 'cc7d454e-5b9f-4d35-b407-d7ac94540a52',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_stub_4_0',
        name: 'tool_call',
        input: { name: STEP_DONE, arguments: { outcome: 'done', summary: 'committed' } },
      },
    ],
    stop_reason: 'tool_use',
  },
});
const question = (tool: string) => ({
  subtype: 'can_use_tool',
  tool_name: tool,
  tool_use_id: 'call_stub_4_0',
  input: { outcome: 'done', summary: 'committed' },
});

async function liveGate() {
  const { task } = await openFresh();
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const gate = createPendingPermits({ selfToolNames: [SELF] });
  const copyRoot = tempDir('copy-');
  const deps = {
    gate,
    codec: SDK_PERMIT_CODEC,
    mapPermission: mapQwenPermission,
    context: {
      copyRoot,
      ownedPaths: [],
      deny: { paths: [], commands: [], mcpTools: [SELF], tools: [] },
      platformPaths: [],
      endpointSources: [],
      grantRequired: [],
      grants: [],
    },
    settleMs: 80,
  };
  // Поток — через настоящий нормализатор формата SDK, как его читает рантайм сессий.
  const normaliser = new SdkNormaliser({ echo: false, mapPermission: mapQwenPermission });
  for (const event of normaliser.push(ASSISTANT_FRAME)) gate.observe(seeded.sessionId, event);
  const signals = () =>
    readJournalLines(task.dir, task.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string }).signal);
  return { task, b: bound.binding, deps, signals };
}

describe('pending permits — the qwen proxy question on the permit road', () => {
  it('step_done asked through tool_call is decided by policy, no forged-authority', async () => {
    const s = await liveGate();
    const out = await answerPermitCall(s.task, s.b, question(STEP_DONE), s.deps);
    expect(out.kind).toBe('decided');
    expect(s.signals()).not.toContain(FORGED_AUTHORITY);
  });

  it('a forged question riding the same tool_call id trips forged-authority', async () => {
    const s = await liveGate();
    const forged = await answerPermitCall(s.task, s.b, question('run_shell_command'), s.deps);
    expect(forged).toMatchObject({ kind: 'forged', reply: { behavior: 'deny' } });
    expect(s.signals()).toContain(FORGED_AUTHORITY);
    const self = await answerPermitCall(s.task, s.b, question('tool_call'), s.deps);
    expect(self.kind).toBe('forged');
  });
});
