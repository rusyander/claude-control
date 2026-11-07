import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  SessionStreamEvent,
  SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { coreChatBookPath, createCoreChatBook } from './core-chat-book.ts';
import { createCoreChatHistory, foldSessionEvents } from './core-chat-history.ts';
import type { CoreChatPort } from './core-run.types.ts';
import { SOURCE_OPENER } from '../initiative/initiative.ts';

/**
 * История разговора не-Claude CLI (этап 11, волна 3): лента, сводка списка и отпечаток опроса —
 * из видов сеансов ядра задач книги. Ядро здесь — подставной порт с видами и страницами; свёртка,
 * окно, кэш и книга — настоящие.
 */

const MARK = '<!-- agentdeck:platform -->';
const HUMAN = `${MARK}\nagentdeck-from: human\n[agentdeck · human-origin] Message from the human to this step:\n`;
const T1 = 1_793_989_152_846;

const ev = (offset: number, kind: SessionStreamEvent['kind'], data: object): SessionStreamEvent =>
  ({ offset, kind, data }) as SessionStreamEvent;

const turn = (at: number, said: string, answer: string, sentAt?: number): SessionStreamEvent[] => [
  ev(at, 'user-text', { text: said, ...(sentAt === undefined ? {} : { sentAt }) }),
  ev(at + 10, 'assistant-text', { text: answer.slice(0, 2) }),
  ev(at + 20, 'assistant-text', { text: answer.slice(2) }),
  ev(at + 30, 'usage', { messageId: `m${at}`, input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }),
  ev(at + 40, 'turn-end', { isError: false, numTurns: 1 }),
];

describe('foldSessionEvents — a core session view becomes feed messages', () => {
  it('a turn is the human words without the service header and one merged answer at the stamp of its send', () => {
    const out = foldSessionEvents(
      's1',
      [
        ...turn(0, `${MARK}\nист-1: qwen`, 'готов', T1),
        ...turn(100, `${HUMAN}ист-2: qwen`, 'опять', T1 + 5000),
      ],
      'qwen3',
    );
    expect(out.map((m) => [m.role, m.blocks, m.timestamp])).toEqual([
      ['user', [{ type: 'text', text: 'ист-1: qwen' }], new Date(T1).toISOString()],
      ['assistant', [{ type: 'text', text: 'готов' }], new Date(T1).toISOString()],
      ['user', [{ type: 'text', text: 'ист-2: qwen' }], new Date(T1 + 5000).toISOString()],
      ['assistant', [{ type: 'text', text: 'опять' }], new Date(T1 + 5000).toISOString()],
    ]);
    expect(out[1]!.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheCreation: 2,
      model: 'qwen3',
    });
    expect(out.map((m) => m.id)).toEqual([
      's1:0:user',
      's1:10:assistant',
      's1:100:user',
      's1:110:assistant',
    ]);
  });

  it('a send with no stamp takes the previous turn time; the very first the epoch', () => {
    const out = foldSessionEvents(
      's',
      [...turn(0, 'a', 'x1'), ...turn(50, 'b', 'x2', T1), ...turn(90, 'c', 'x3')],
      undefined,
    );
    expect(out.map((m) => m.timestamp)).toEqual([
      new Date(0).toISOString(),
      new Date(0).toISOString(),
      new Date(T1).toISOString(),
      new Date(T1).toISOString(),
      new Date(T1).toISOString(),
      new Date(T1).toISOString(),
    ]);
  });

  it('thinking, tools with a failed result, repeated usage of one message, an error end; blank words and a usage-only reply leave nothing', () => {
    const out = foldSessionEvents(
      's',
      [
        ev(0, 'user-text', { text: 'do', sentAt: T1 }),
        ev(5, 'thinking', { text: 'hm' }),
        ev(6, 'thinking', { text: 'm' }),
        ev(7, 'tool-call', { toolUseId: 'tu1', name: 'Read', input: { path: 'a.ts' } }),
        ev(8, 'tool-result', { toolUseId: 'tu1', isError: true }),
        ev(9, 'tool-call', { toolUseId: 'tu2', name: 'Bash', input: null }),
        ev(10, 'tool-result', { toolUseId: 'tu2', isError: false }),
        ev(11, 'usage', { messageId: 'm1', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
        ev(12, 'usage', { messageId: 'm1', input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }),
        ev(13, 'usage', { messageId: 'm2', input: 4, output: 1, cacheRead: 0, cacheWrite: 0 }),
        ev(14, 'turn-end', { isError: true, text: 'Prompt is too long' }),
        ev(20, 'user-text', { text: '   ' }),
        ev(21, 'usage', { messageId: 'm3', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
        ev(22, 'turn-end', { isError: false }),
      ],
      undefined,
    );
    expect(out).toHaveLength(2);
    expect(out[1]!.blocks).toEqual([
      { type: 'thinking', text: 'hmm' },
      { type: 'tool', name: 'Read', input: '{"path":"a.ts"}', isError: true },
      { type: 'tool', name: 'Bash', input: '{}' },
      { type: 'text', text: 'Prompt is too long' },
    ]);
    expect(out[1]!.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheCreation: 0 });
  });
});

type FakeTask = {
  seq: number;
  ended: TaskView['ended'];
  sessions: Record<string, SessionStreamEvent[]>;
  model?: string;
};

function fakePort(tasks: Record<string, FakeTask>) {
  const calls = { view: 0, page: 0 };
  let down = false;
  const port: Pick<CoreChatPort, 'view' | 'page'> = {
    async view(taskId) {
      calls.view += 1;
      if (down) throw new Error('core down');
      const t = tasks[taskId];
      if (!t) return null;
      return {
        taskId,
        seq: t.seq,
        ended: t.ended,
        sessions: Object.keys(t.sessions).map((sessionId, i) => ({
          sessionId,
          stepId: 'step',
          startedSeq: i + 1,
          modelAsked: t.model ?? null,
          modelServed: null,
        })),
      } as unknown as TaskView;
    },
    async page(taskId, sessionId) {
      calls.page += 1;
      const events = tasks[taskId]!.sessions[sessionId]!;
      return {
        taskId,
        sessionId,
        adapter: 'qwen',
        events,
        next: events.length * 100,
        done: false,
      } as SessionStreamPage;
    },
  };
  return { port, calls, setDown: (v: boolean) => (down = v) };
}

describe('createCoreChatHistory — feed, list and poll of a non-Claude conversation from the core', () => {
  const dirs: string[] = [];
  const bookIn = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'core-chat-history-'));
    dirs.push(dir);
    return coreChatBookPath(dir);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const file = bookIn();
    const tasks: Record<string, FakeTask> = {
      t1: {
        seq: 9,
        ended: 'done',
        model: 'qwen3',
        sessions: { s1: [...turn(0, `${MARK}\nист-1: qwen слово`, 'готов', T1)] },
      },
      t2: {
        seq: 4,
        ended: null,
        model: 'qwen3-max',
        sessions: {
          s2: [
            ...turn(0, `${HUMAN}ист-2`, 'готов', T1 + 1000),
            ...turn(100, `${HUMAN}ист-3`, 'готов', T1 + 2000),
          ],
        },
      },
    };
    const book = createCoreChatBook(file);
    book.set('conv', { taskId: 't1', stepId: 'step', cli: 'qwen', cwd: 'C:/work/proj' });
    book.forget('conv');
    book.set('conv', { taskId: 't2', stepId: 'step' });
    book.set('claude-conv', { taskId: 'tc', stepId: 'step', cli: 'claude', cwd: 'C:/work/proj' });
    const fake = fakePort(tasks);
    return { file, tasks, ...fake, history: createCoreChatHistory(fake.port, () => file) };
  }

  it('the feed is every task of the conversation in order, windowed from the end like a transcript', async () => {
    const { history } = setup();
    const all = await history.messages('conv', { limit: 50, offset: 0 });
    expect(all?.total).toBe(6);
    expect(
      all?.messages.map(
        (m) => `${m.role}:${m.blocks.map((b) => ('text' in b ? b.text : '')).join('')}`,
      ),
    ).toEqual([
      'user:ист-1: qwen слово',
      'assistant:готов',
      'user:ист-2',
      'assistant:готов',
      'user:ист-3',
      'assistant:готов',
    ]);
    const last = await history.messages('conv', { limit: 2, offset: 1 });
    expect(last?.messages.map((m) => m.id)).toEqual(['s2:10:assistant', 's2:100:user']);
    expect(last?.hasMore).toBe(true);
  });

  it('a Claude or unknown conversation is not served from the core', async () => {
    const { history, calls } = setup();
    expect(await history.messages('claude-conv', { limit: 50, offset: 0 })).toBeUndefined();
    expect(await history.messages('nope', { limit: 50, offset: 0 })).toBeUndefined();
    expect(await history.version('claude-conv')).toBeUndefined();
    expect(calls.view).toBe(0);
  });

  it('the list summary: title from the first words, folder, count, last model and time', async () => {
    const { history } = setup();
    expect(await history.summaries()).toEqual([
      {
        id: 'conv',
        title: 'ист-1: qwen слово',
        project: 'C--work-proj',
        projectPath: 'C:/work/proj',
        isSandbox: false,
        messageCount: 6,
        createdAt: new Date(T1).toISOString(),
        updatedAt: new Date(T1 + 2000).toISOString(),
        preview: 'готов',
        model: 'qwen3-max',
      },
    ]);
  });

  it('an ended task is read once per journal number; a live one every time; the version follows the output', async () => {
    const { history, calls, tasks } = setup();
    const v1 = await history.version('conv');
    expect(v1).toEqual({ mtimeMs: T1 + 2000, size: 500 + 1000 });
    expect(calls.page).toBe(2);
    await history.messages('conv', { limit: 50, offset: 0 });
    expect(calls.page).toBe(3);
    tasks.t2!.sessions.s2!.push(...turn(200, `${HUMAN}ист-4`, 'готов', T1 + 3000));
    expect(await history.version('conv')).toEqual({ mtimeMs: T1 + 3000, size: 500 + 1500 });
    tasks.t1!.seq = 10;
    await history.version('conv');
    expect(calls.page).toBe(6);
  });

  it('the core down: the conversation keeps its last known history; never seen — left out, no throw', async () => {
    const { history, setDown, file } = setup();
    await history.summaries();
    setDown(true);
    expect((await history.summaries()).map((s) => s.messageCount)).toEqual([6]);
    const never = fakePort({});
    never.setDown(true);
    const cold = createCoreChatHistory(never.port, () => file);
    expect(await cold.summaries()).toEqual([]);
  });

  /** Разговор из одной задачи с первой репликой `said` — для названия и ленты продолжения. */
  function single(said: string) {
    const file = bookIn();
    const fake = fakePort({
      t9: { seq: 1, ended: 'done', sessions: { s9: [...turn(0, said, 'готов', T1)] } },
    });
    createCoreChatBook(file).set('c9', {
      taskId: 't9',
      stepId: 'step',
      cli: 'qwen',
      cwd: 'C:/work/proj',
    });
    return createCoreChatHistory(fake.port, () => file);
  }

  it('the list title drops links down to the tracker key, as a Claude transcript title does', async () => {
    const history = single('https://tracker.example.com/browse/PROJ-12 почини выгрузку');
    expect((await history.summaries())[0]?.title).toBe('PROJ-12 почини выгрузку');
  });

  it('a foreign continuation: the panel initiative after the task text is not shown in the feed nor the title', async () => {
    const said = `передача-77: продолжай\n\n${SOURCE_OPENER} Below is what you need to know.`;
    const history = single(said);
    const feed = await history.messages('c9', { limit: 50, offset: 0 });
    const texts = feed?.messages.map((m) =>
      m.blocks.map((b) => ('text' in b ? b.text : '')).join(''),
    );
    expect(texts).toEqual(['передача-77: продолжай', 'готов']);
    expect((await history.summaries())[0]?.title).toBe('передача-77: продолжай');
  });
});
