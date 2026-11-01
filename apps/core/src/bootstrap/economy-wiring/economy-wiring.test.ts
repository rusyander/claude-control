import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { fixturePath } from '../../adapters/conformance/__fixtures__/replay.ts';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import { SdkNormaliser } from '../../adapters/sdk-stream/normalise.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { WindowBook, windowHealth } from '../../economy/window/index.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { usageOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createSessionRuntime } from '../session-runtime.ts';
import { createEconomyWiring } from './index.ts';

/**
 * Кран экономики на настоящем рантайме сессий (P43, P19): N событий расхода — N строк
 * `turn.usage`, повтор потока после переподключения не пишется, итог свёртки равен сумме трассы;
 * факт окна пишет `window.state` только при смене вердикта, книга окон видит маршрут.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

function fakeAdapter(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'claude',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

async function taskWithSession(): Promise<{ task: LiveTask; sessionId: string }> {
  const registry = createTaskRegistry(tempDir('econ-wire-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  return { task, sessionId };
}

async function pump(
  task: LiveTask,
  sessionId: string,
  events: AdapterEvent[],
  wiring: ReturnType<typeof createEconomyWiring>,
): Promise<void> {
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const attached = createSessionRuntime({ economy: wiring }).attach({
    task,
    binding: got.binding,
    adapter: fakeAdapter(events),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    resumed: false,
    onEvent: () => {},
  });
  await attached.done;
}

const linesOf = (task: LiveTask, kind: string) =>
  readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === kind);

const usage = (messageId: string, input: number, output: number, extra = {}): AdapterEvent => ({
  type: 'usage',
  messageId,
  input,
  cacheRead: 10,
  cacheWrite: 4,
  output,
  ...extra,
});

describe('economy wiring — usage through the session runtime (P43)', () => {
  it('N usage events give N turn.usage lines; a replayed stream adds none; fold = trace sum', async () => {
    const { task, sessionId } = await taskWithSession();
    const wiring = createEconomyWiring();
    const trace = [usage('m1', 100, 5), usage('m2', 200, 7, { model: 'claude-x-1' })];
    await pump(task, sessionId, trace, wiring);
    expect(linesOf(task, 'turn.usage')).toHaveLength(2);
    // Хост отдал тот же поток заново (переподключение): строк не прибавилось.
    await pump(task, sessionId, trace, wiring);
    expect(linesOf(task, 'turn.usage')).toHaveLength(2);
    expect(usageOf(task.state, 'task')).toEqual({
      input: 300,
      cacheRead: 20,
      cacheWrite: 8,
      cacheWrite1h: 0,
      output: 12,
      turns: 2,
    });
    expect(usageOf(task.state, `session:${sessionId}`).turns).toBe(2);
    const models = linesOf(task, 'turn.usage').map((l) => (l.data as { model: string }).model);
    // Нет имени в потоке — модель сеанса (`model-a` из засева).
    expect(models).toEqual(['model-a', 'claude-x-1']);
  });

  it('a grown repeat of the same message replaces it, a subagent turn counts in both totals', async () => {
    const { task, sessionId } = await taskWithSession();
    await pump(
      task,
      sessionId,
      [
        usage('m1', 100, 5),
        usage('m1', 100, 9),
        usage('s1', 50, 1, { subagent: true, cacheWrite1h: 99 }),
      ],
      createEconomyWiring(),
    );
    expect(linesOf(task, 'turn.usage')).toHaveLength(3);
    expect(usageOf(task.state, 'task')).toMatchObject({ input: 150, output: 10, turns: 2 });
    // Доля 1h не больше всей записи кэша: 99 из 4 даёт 4.
    expect(usageOf(task.state, 'subagents')).toMatchObject({
      input: 50,
      cacheWrite1h: 4,
      turns: 1,
    });
    const sub = linesOf(task, 'turn.usage').at(-1)!.data as { parentSessionId: string | null };
    expect(sub.parentSessionId).toBe(sessionId);
  });

  it('the window the session reports (claude recording, result.modelUsage.contextWindow) lands on turn.usage: the first turn is rewritten once with it, the next carries it, the fold counts two turns', async () => {
    const { task, sessionId } = await taskWithSession();
    const n = new SdkNormaliser({ echo: true, mapPermission: mapClaudePermission });
    n.expect(A, A);
    n.expect(B, B);
    const events: AdapterEvent[] = [];
    for (const raw of readFileSync(fixturePath('claude', 'basic'), 'utf8').split('\n'))
      if (raw.trim()) events.push(...n.push(raw));
    await pump(task, sessionId, events, createEconomyWiring());
    const rows = linesOf(task, 'turn.usage').map(
      (l) => l.data as { messageId: string; contextWindow?: number },
    );
    expect(rows.map((r) => [r.messageId, r.contextWindow ?? null])).toEqual([
      ['msg_stub_1', null],
      ['msg_stub_1', 64_000],
      ['msg_stub_2', 64_000],
    ]);
    // Переписанная строка заменяет прежнюю: ходов два, вход не удвоен.
    expect(usageOf(task.state, 'task')).toMatchObject({ input: 22, turns: 2 });
  });
});

describe('economy wiring — window facts (P19, G7)', () => {
  it('window.state is journaled only when the verdict changes; the book holds the route', async () => {
    const { task, sessionId } = await taskWithSession();
    let now = 1_000_000;
    const book = new WindowBook();
    const wiring = createEconomyWiring({ windows: book, now: () => now });
    const win = (usedPct: number, warning = false, refusal = false): AdapterEvent => ({
      type: 'window',
      limitKind: 'window',
      usedPct,
      resetAt: 2_000_000,
      window: 'five_hour',
      warning,
      refusal,
    });
    await pump(task, sessionId, [win(40), win(50), win(75, true), win(92), win(95)], wiring);
    const verdicts = linesOf(task, 'window.state').map(
      (l) => (l.data as { verdict: string }).verdict,
    );
    expect(verdicts).toEqual(['open', 'warn', 'held']);
    expect(windowHealth(book, now).routes).toMatchObject([
      { routeId: 'stub-1', limitKind: 'window', verdict: 'held', usedPct: 95 },
    ]);
    now = 2_000_000;
    await pump(task, sessionId, [win(3)], wiring);
    expect(linesOf(task, 'window.state').at(-1)!.data).toMatchObject({ verdict: 'open' });
  });
});
