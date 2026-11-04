import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoreRelay } from './core-relay.ts';
import type { CoreRelayCore, CoreSseEvent, RelayAsk, RelayTask } from './core-relay.types.ts';
import { parseSse } from './sse.ts';

/**
 * Пересылка вопросов ядра (этап 10, зона D): ровно одно уведомление на открытый вопрос, ссылка
 * на ту же задачу, курсор переживает перезапуск панели (новая пересылка читает поток с места).
 * Ядро здесь — список строк журнала; настоящий путь (ядро стенда, Bot API) —
 * `tools/qa/check-core-relay.mjs`.
 */

const TASK = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const ASK = '019a0000-0000-7000-8000-0000000000a1';
const ASK_ANSWERED = '019a0000-0000-7000-8000-0000000000a2';

const line = (seq: number, kind: string, data: Record<string, unknown> = {}): CoreSseEvent => ({
  id: String(seq),
  event: kind,
  data: JSON.stringify({ seq, kind, taskId: TASK, data }),
});

interface FakeCore extends CoreRelayCore {
  calls: { taskId: string; lastEventId: string | undefined }[];
}

/** Ядро: журнал каждой задачи отдаётся с места `lastEventId` и поток закрывается. */
function fakeCore(
  journals: Record<string, CoreSseEvent[]>,
  tasks: RelayTask[],
  states: Record<string, string>,
): FakeCore {
  const calls: FakeCore['calls'] = [];
  return {
    calls,
    tasks: async () => tasks,
    askState: async (_taskId, askId) => states[askId] ?? null,
    async *events(taskId, lastEventId) {
      calls.push({ taskId, lastEventId });
      const from = Number(lastEventId ?? 0);
      for (const event of journals[taskId] ?? []) if (Number(event.id) > from) yield event;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-core-relay-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function settle(relay: ReturnType<typeof createCoreRelay>): Promise<void> {
  await relay.tick();
  // Потоки идут фоном; `stop` дожидается их и записи курсоров.
  await relay.stop();
}

describe('core relay: one notice per open ask, cursor survives a panel restart', () => {
  it('open ask → one notice with a deep link to the same task; answered ask and other kinds → nothing', async () => {
    const journal = [
      line(1, 'task.created'),
      line(2, 'human.asked', { askId: ASK_ANSWERED, question: 'старый' }),
      line(3, 'human.answered', { askId: ASK_ANSWERED }),
      line(4, 'human.asked', { askId: ASK, question: 'Делить задачу?' }),
      line(5, 'step.started'),
    ];
    const core = fakeCore(
      { [TASK]: journal },
      [{ taskId: TASK, live: true, title: 'Починить вход' }],
      {
        [ASK_ANSWERED]: 'answered',
        [ASK]: 'open',
      },
    );
    const sent: RelayAsk[] = [];
    const statePath = join(dir, 'core-relay.json');
    const relay = createCoreRelay({
      core,
      statePath,
      deliver: async (ask) => sent.push(ask) > 0,
      link: (taskId, askId) => `http://127.0.0.1:8888/core?id=${taskId}&ask=${askId}`,
      log: () => undefined,
    });
    await settle(relay);
    expect(sent).toEqual([
      {
        notice: {
          taskId: TASK,
          askId: ASK,
          kind: 'ask',
          title: 'Починить вход',
          deepLink: `http://127.0.0.1:8888/core?id=${TASK}&ask=${ASK}`,
        },
        question: 'Делить задачу?',
      },
    ]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      cursors: { [TASK]: '5' },
      delivered: [ASK],
      pending: [],
    });
  });

  it('a new relay (panel restarted) resumes from the persisted cursor and says nothing twice', async () => {
    const journal = [
      line(1, 'task.created'),
      line(2, 'human.asked', { askId: ASK, question: 'q' }),
    ];
    const statePath = join(dir, 'core-relay.json');
    const sent: RelayAsk[] = [];
    const make = (core: FakeCore) =>
      createCoreRelay({
        core,
        statePath,
        deliver: async (ask) => sent.push(ask) > 0,
        link: (taskId, askId) => `${taskId}/${askId}`,
        log: () => undefined,
      });
    const tasks = [{ taskId: TASK, live: true, title: null }];
    await settle(make(fakeCore({ [TASK]: journal }, tasks, { [ASK]: 'open' })));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.notice.title).toBe('Задача ядра');

    const again = fakeCore({ [TASK]: [...journal, line(3, 'step.started')] }, tasks, {
      [ASK]: 'open',
    });
    await settle(make(again));
    // Поток после перезапуска — с курсора, не с начала.
    expect(again.calls).toEqual([{ taskId: TASK, lastEventId: '2' }]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).cursors).toEqual({ [TASK]: '3' });

    // Курсор потерян (файл без курсоров), список отправленного цел — второго сообщения всё равно нет.
    writeFileSync(statePath, JSON.stringify({ cursors: {}, delivered: [ASK] }));
    const lost = fakeCore({ [TASK]: journal }, tasks, { [ASK]: 'open' });
    await settle(make(lost));
    expect(lost.calls).toEqual([{ taskId: TASK, lastEventId: undefined }]);
    expect(sent).toHaveLength(1);
  });

  it('no channel → the ask stays pending (not delivered); a channel appears → one notice, also after a restart; answered meanwhile → none', async () => {
    const journal = [
      line(1, 'human.asked', { askId: ASK, question: 'Делить?' }),
      line(2, 'step.started'),
    ];
    const statePath = join(dir, 'core-relay.json');
    let channel = false;
    const sent: RelayAsk[] = [];
    const states: Record<string, string> = { [ASK]: 'open' };
    const tasks = [{ taskId: TASK, live: true, title: 'Вход' }];
    const make = () =>
      createCoreRelay({
        core: fakeCore({ [TASK]: journal }, tasks, states),
        statePath,
        ready: () => channel,
        deliver: async (ask) => {
          if (!channel) return false;
          sent.push(ask);
          return true;
        },
        link: (taskId, askId) => `${taskId}/${askId}`,
        log: () => undefined,
      });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

    // Канала нет: поток прочитан до конца, но вопрос не «сообщён» — ждёт в pending.
    const first = make();
    await first.tick();
    await flush();
    expect(sent).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      cursors: { [TASK]: '2' },
      delivered: [],
      pending: [{ taskId: TASK, askId: ASK, question: 'Делить?' }],
    });
    // Канал появился — следующий круг той же пересылки сообщает ровно раз.
    channel = true;
    await first.tick();
    await first.tick();
    await first.stop();
    expect(sent.map((ask) => [ask.notice.askId, ask.notice.title, ask.question])).toEqual([
      [ASK, 'Вход', 'Делить?'],
    ]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      cursors: { [TASK]: '2' },
      delivered: [ASK],
      pending: [],
    });

    // Перезапуск панели при ждущем вопросе: курсор уже за строкой вопроса — сообщает pending.
    sent.length = 0;
    channel = false;
    writeFileSync(
      statePath,
      JSON.stringify({
        cursors: { [TASK]: '2' },
        delivered: [],
        pending: [{ taskId: TASK, askId: ASK, question: 'Делить?' }],
      }),
    );
    channel = true;
    await settle(make());
    expect(sent.map((ask) => ask.notice.askId)).toEqual([ASK]);

    // Ответили, пока ждал канала, — сообщать не о чем, из pending уходит.
    sent.length = 0;
    writeFileSync(
      statePath,
      JSON.stringify({
        cursors: { [TASK]: '2' },
        delivered: [],
        pending: [{ taskId: TASK, askId: ASK, question: 'Делить?' }],
      }),
    );
    states[ASK] = 'answered';
    await settle(make());
    expect(sent).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).pending).toEqual([]);
  });

  it('stop (panel shutdown) writes the unflushed cursor synchronously and closes the live stream', async () => {
    const statePath = join(dir, 'core-relay.json');
    let closed = false;
    const core: CoreRelayCore = {
      tasks: async () => [{ taskId: TASK, live: true, title: 't' }],
      askState: async () => 'open',
      // Поток живой: строка пришла, дальше ждёт, пока его не закроют.
      async *events(_taskId, _lastEventId, signal) {
        yield line(7, 'step.started');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        closed = true;
      },
    };
    const relay = createCoreRelay({
      core,
      statePath,
      deliver: async () => true,
      link: () => '',
      log: () => undefined,
    });
    await relay.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Курсор пишется не чаще раза в секунду — на диске его ещё нет.
    expect(() => readFileSync(statePath, 'utf8')).toThrow();
    const stopping = relay.stop();
    // Без `await`: выход панели идёт сразу за `shutdown`.
    expect(JSON.parse(readFileSync(statePath, 'utf8')).cursors).toEqual({ [TASK]: '7' });
    await stopping;
    expect(closed).toBe(true);
  });

  it('failed delivery waits in pending and is retried; ended tasks are not followed; dead core logs once', async () => {
    const journal = [line(1, 'human.asked', { askId: ASK, question: 'q' })];
    const statePath = join(dir, 'core-relay.json');
    let fail = true;
    const sent: RelayAsk[] = [];
    const logs: string[] = [];
    const core = fakeCore(
      { [TASK]: journal, [OTHER]: [line(1, 'human.asked', { askId: ASK_ANSWERED })] },
      [
        { taskId: TASK, live: true, title: 't' },
        { taskId: OTHER, live: false, title: 'ended' },
      ],
      { [ASK]: 'open' },
    );
    const make = () =>
      createCoreRelay({
        core,
        statePath,
        deliver: async (ask) => {
          if (fail) throw new Error('channel down');
          return sent.push(ask) > 0;
        },
        link: (taskId, askId) => `${taskId}/${askId}`,
        log: (text) => logs.push(text),
      });
    const first = make();
    await first.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    expect(logs).toContain('core-relay: not delivered: channel down');
    // Упавший канал не дёргается каждым кругом: повтор той же пересылкой — не раньше паузы.
    fail = false;
    await first.tick();
    await first.stop();
    expect(sent).toEqual([]);
    // Новая панель пробует ждущий вопрос сразу.
    await settle(make());
    expect(sent.map((ask) => ask.notice.askId)).toEqual([ASK]);
    expect(core.calls.every((call) => call.taskId === TASK)).toBe(true);

    logs.length = 0;
    const down = createCoreRelay({
      core: { ...core, tasks: async () => Promise.reject(new Error('procs.json: ENOENT')) },
      statePath,
      deliver: async () => true,
      link: () => '',
      log: (text) => logs.push(text),
    });
    await down.tick();
    await down.tick();
    await down.stop();
    expect(logs).toEqual(['core-relay: core unavailable: procs.json: ENOENT']);
  });
});

describe('parseSse', () => {
  it('reads id/event/data, skips comments, keeps CRLF and split chunks, drops an unfinished event', async () => {
    const text =
      ': open\n\nid: 7\nevent: human.asked\ndata: {"a":1}\n\n: ping\r\n\r\nid: 8\r\ndata: x\r\ndata: y\r\n\r\nid: 9\ndata: cut';
    const bytes = new TextEncoder().encode(text);
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 5) yield bytes.slice(at, at + 5);
    }
    const out: CoreSseEvent[] = [];
    for await (const event of parseSse(chunks())) out.push(event);
    expect(out).toEqual([
      { id: '7', event: 'human.asked', data: '{"a":1}' },
      { id: '8', event: null, data: 'x\ny' },
    ]);
  });
});
