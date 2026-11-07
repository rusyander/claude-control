import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { ChatAttachment, EstimateFields } from '@agentdeck/contracts/core/estimate';
import { LOCAL_LAYER_INSTRUCTIONS_MAX } from '@agentdeck/contracts/core/session-carry';
import { ATTACHMENTS_MARKER, joinAttachments } from '@agentdeck/contracts/uploads';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import {
  HUMAN_ORIGIN_MARK,
  type SessionStreamEvent,
  type SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { randomUUID7 } from '../../core-ask/core-ask.ts';
import type { ChatEvent } from '../chat-events.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import { CORE_CHAT_STOP_REASON, CoreChatRun, grantGlob, onDiskPath } from './core-run.ts';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunNotice,
} from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { writePlatform } from '../../platform/store/store.ts';
import { modelRulesFor } from '../../platform/models/models.ts';
import { chatContourRoutes, coreGatewayRouteId } from '../../platform/routing/core-contour.ts';
import type {
  CoreChatBook,
  CoreChatEntry,
  CoreChatPort,
  CorePermissionDesk,
} from './core-run.types.ts';
import { translate, TURN_ERROR_TEXT } from './translate.ts';
import { foldSessionEvents } from './core-chat-history.ts';
import { localizeText, serverText } from '../../../lib/server-texts/server-texts.ts';
import { runErrorCode } from '../run-errors/run-errors.ts';

/**
 * Ход чата через ядро (этап 10, F2, проход 3) против управляемого ядра: порт отвечает как ядро
 * (вид задачи, вид сеанса страницами, журнал задачи), прогон — настоящий `CoreChatRun`.
 */

type Ev = Omit<SessionStreamEvent, 'offset'>;

interface FakeOptions {
  estimate?: Awaited<ReturnType<CoreChatPort['estimate']>> | Error;
  reject?: Partial<Record<string, CommandOutcome>>;
  /** Ход сеанса: события, которые ядро пишет после запуска / после сообщения шагу. */
  turn?: Ev[];
  /** Уже записанное в сеансе живого шага до этого хода. */
  history?: Ev[];
  /** Сеанс кончается без конца хода, следующий сеанс шага пишет `turn`. */
  restart?: boolean;
  journal?: JournalLine[];
  askState?: string;
  hold?: boolean;
  /** Шаг кончается неудачей без сеанса с этой причиной ядра (отказ запуска). */
  stepFailed?: string;
  /** Ответ ядра на вложение следующего хода (s10 G11). */
  attach?: Awaited<ReturnType<CoreChatPort['attach']>>;
}

function fakeCore(opts: FakeOptions = {}) {
  const taskId = randomUUID7();
  const stepId = randomUUID7();
  const sessions = [randomUUID7(), randomUUID7()];
  const calls: Array<{ kind: string; fields: unknown }> = [];
  const estimates: EstimateFields[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const inline: Array<ChatAttachment[] | undefined> = [];
  const attached: ChatAttachment[] = [];
  const pagesFrom: number[] = [];
  let launched = false;
  let liveSessions = 0;
  const streams = new Map<string, SessionStreamEvent[]>();
  let offset = 0;
  const write = (sid: string, events: Ev[]): void => {
    const list = streams.get(sid) ?? [];
    for (const e of events) list.push({ ...e, offset: (offset += 10) });
    streams.set(sid, list);
  };
  const view = (): TaskView =>
    ({
      taskId,
      ended: null,
      steps: launched
        ? [
            {
              stepId,
              stepKind: 'chat',
              state: opts.stepFailed ? 'failed' : 'running',
              startedSeq: 1,
              outcome: opts.stepFailed ? 'failed' : null,
              reason: opts.stepFailed ?? null,
            },
          ]
        : [],
      sessions: sessions
        .slice(0, liveSessions)
        .map((sessionId, i) => ({ sessionId, stepId, startedSeq: 2 + i })),
      asks: (opts.journal ?? []).map((l) => ({
        askId: (l.data as { askId: string }).askId,
        state: opts.askState ?? 'open',
      })),
    }) as unknown as TaskView;
  const port: CoreChatPort = {
    async estimate(fields, env, attachments) {
      estimates.push(fields);
      envs.push(env);
      inline.push(attachments);
      if (opts.estimate instanceof Error) throw opts.estimate;
      return opts.estimate ?? { ok: true, taskId };
    },
    async attach(id, attachment) {
      expect(id).toBe(taskId);
      attached.push(attachment);
      if (opts.attach) return opts.attach;
      return { ok: true, file: `CORE/${taskId}/attachments/${attached.length}/${attachment.name}` };
    },
    async command(id, kind, fields) {
      expect(id).toBe(taskId);
      calls.push({ kind, fields });
      const refused = opts.reject?.[kind];
      if (refused) return refused;
      if (kind === 'launch') {
        launched = true;
        liveSessions = opts.stepFailed ? 0 : 1;
        if (opts.restart) {
          write(sessions[0]!, [{ kind: 'assistant-text', data: { text: 'half' } }]);
          liveSessions = 2;
        }
        if (!opts.hold) write(sessions[opts.restart ? 1 : 0]!, opts.turn ?? []);
      }
      if (kind === 'message-to-step' && !opts.hold) {
        write(sessions[0]!, [
          { kind: 'user-text', data: { text: (fields as { text: string }).text } },
          ...(opts.turn ?? []),
        ]);
      }
      return { cmdId: 'c', status: 'applied', seq: calls.length } as CommandOutcome;
    },
    async view(id) {
      return id === taskId ? view() : null;
    },
    async page(_t, sid, from) {
      pagesFrom.push(from);
      const events = (streams.get(sid) ?? []).filter((e) => e.offset >= from);
      return { taskId, sessionId: sid, adapter: 'claude', events, next: offset + 1, done: false };
    },
    async *follow(_t, sid, from, signal) {
      const events = (streams.get(sid) ?? []).filter((e) => e.offset >= from);
      const ended = opts.restart && sid === sessions[0];
      const page: SessionStreamPage = {
        taskId,
        sessionId: sid,
        adapter: 'claude',
        events,
        next: offset,
        done: Boolean(ended),
      };
      yield page;
      if (ended) return;
      // Живой сеанс: новые строки уходят следующими страницами, пока поток не оборвут.
      let sent = (streams.get(sid) ?? []).length;
      while (!signal.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        const list = streams.get(sid) ?? [];
        if (list.length === sent) continue;
        yield { ...page, events: list.slice(sent), next: offset };
        sent = list.length;
      }
    },
    async *taskEvents(_t, signal) {
      for (const line of opts.journal ?? []) yield line;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
  };
  return {
    port,
    taskId,
    stepId,
    sessions,
    calls,
    estimates,
    envs,
    inline,
    attached,
    pagesFrom,
    write,
    seed(conversation: string, book: CoreChatBook) {
      launched = true;
      liveSessions = 1;
      write(sessions[0]!, opts.history ?? []);
      book.set(conversation, { taskId, stepId });
    },
  };
}

/** Книга в памяти с тем же правилом, что файловая: `forget` снимает задачу, CLI помнит. */
function memoryBook(): CoreChatBook & { entries: Map<string, CoreChatEntry> } {
  const entries = new Map<string, CoreChatEntry>();
  const clis = new Map<string, string>();
  return {
    entries,
    get: (id) => entries.get(id),
    cliOf: (id) => clis.get(id),
    set: (id, e) => {
      entries.set(id, e);
      if (e.cli) clis.set(id, e.cli);
    },
    forget: (id) => void entries.delete(id),
  };
}

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  prompt: 'Почини тест\nподробности',
  cwd: 'C:/work/proj',
  ...over,
});

const TURN: Ev[] = [
  { kind: 'assistant-text', data: { text: 'Смотрю ' } },
  { kind: 'assistant-text', data: { text: 'код.' } },
  { kind: 'tool-call', data: { toolUseId: 'tu1', name: 'Read', input: { file_path: 'a.ts' } } },
  { kind: 'tool-result', data: { toolUseId: 'tu1', isError: false } },
  {
    kind: 'usage',
    data: { messageId: 'm1', input: 10, output: 5, cacheRead: 100, cacheWrite: 7 },
  },
  { kind: 'turn-end', data: { isError: false, numTurns: 1 } },
];

async function run(run: CoreChatRun, options: RunOptions): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await run.start(options, (e) => events.push(e));
  return events;
}

describe('CoreChatRun — /chat turn through core chat@1', () => {
  it('new chat: estimate in place with an edit grant, set-cli claude, launch; turn translated; book written', async () => {
    const core = fakeCore({ turn: TURN });
    const book = memoryBook();
    const events = await run(new CoreChatRun({ port: core.port, book, pollMs: 1 }), opts());
    expect(core.estimates).toHaveLength(1);
    expect(core.estimates[0]).toMatchObject({
      title: 'Почини тест',
      request: 'Почини тест\nподробности',
      repos: [{ path: 'C:/work/proj', baseRef: null }],
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      placement: { kind: 'in-place', grant: { project: 'C:/work/proj', ops: ['edit'] } },
    });
    expect(core.estimates[0]).not.toHaveProperty('resume');
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
    expect(core.calls[0]!.fields).toEqual({
      scope: 'task',
      scopeId: core.taskId,
      adapter: 'claude',
      timing: 'now',
    });
    const session = core.sessions[0]!;
    expect(events[0]).toMatchObject({ kind: 'session', sessionId: session });
    expect(events.slice(1, -1)).toEqual([
      { kind: 'text', text: 'Смотрю ' },
      { kind: 'text', text: 'код.' },
      { kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, id: 'tu1' },
      { kind: 'toolResult', toolUseId: 'tu1' },
      { kind: 'usage', input: 10, output: 5, cacheRead: 100, cacheCreation: 7 },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'done', sessionId: session, costUsd: 0 });
    // Папка разговора — в книге (волна 3): по ней список чатов ставит разговор не-Claude CLI.
    expect(book.entries.get(session)).toEqual({
      taskId: core.taskId,
      stepId: core.stepId,
      cli: 'claude',
      cwd: 'C:/work/proj',
    });
  });

  // Проход 8: окно подписки сеанса ядра — событие `limit` ленты, как у прежнего исполнителя из
  // `rate_limit_event`: реестр по нему ставит повтор после лимита и пишет долю лимита у чата.
  it('the window of the core session becomes the limit event with a load sample; a broken window is skipped', async () => {
    const reset = 1_793_709_020;
    const core = fakeCore({
      turn: [
        { kind: 'assistant-text', data: { text: 'ответ' } },
        {
          kind: 'window',
          data: {
            limitKind: 'window',
            usedPct: 92,
            resetAt: reset * 1000,
            status: 'allowed_warning',
            window: 'five_hour',
            windows: {
              five_hour: { usedPct: 92, resetAt: reset * 1000 },
              seven_day: { usedPct: 41, resetAt: (reset + 9000) * 1000 },
              seven_day_opus: { usedPct: 99, resetAt: 5000 },
              no_reset: { usedPct: 10, resetAt: null },
            },
          },
        },
        {
          kind: 'window',
          data: {
            limitKind: 'window',
            usedPct: null,
            resetAt: null,
            status: 'rejected',
            window: null,
          },
        },
        { kind: 'window', data: { usedPct: 'много', status: 'nope' } },
        { kind: 'turn-end', data: { isError: false } },
      ],
    });
    const events = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, now: () => 777 }),
      opts(),
    );
    expect(events.slice(1, -1)).toEqual([
      { kind: 'text', text: 'ответ' },
      {
        kind: 'limit',
        resetsAt: reset,
        type: 'five_hour',
        status: 'allowed_warning',
        sample: {
          at: 777,
          fiveHour: { utilization: 0.92, resetsAt: reset },
          sevenDay: { utilization: 0.41, resetsAt: reset + 9000 },
        },
      },
      // Отказ без сброса и имени — ноль и пусто, как у прежнего исполнителя; замера нет.
      { kind: 'limit', resetsAt: 0, type: '', status: 'rejected' },
    ]);
  });

  it('old conversation without a live step: estimate carries resume of that conversation, session keeps its id', async () => {
    const core = fakeCore({ turn: TURN });
    const book = memoryBook();
    const events = await run(
      new CoreChatRun({ port: core.port, book, pollMs: 1 }),
      opts({ sessionId: 'conv-1' }),
    );
    expect(core.estimates[0]!.resume).toEqual({ adapter: 'claude', conversationId: 'conv-1' });
    expect(events[0]).toMatchObject({ kind: 'session', sessionId: 'conv-1' });
    expect(events.at(-1)).toMatchObject({ kind: 'done', sessionId: 'conv-1' });
    expect(book.entries.get('conv-1')?.taskId).toBe(core.taskId);
  });

  it('live chat step in the book: message-to-step, no new task, earlier turns not replayed', async () => {
    const core = fakeCore({
      turn: [
        { kind: 'assistant-text', data: { text: 'второй ход' } },
        { kind: 'turn-end', data: { isError: false } },
      ],
      history: [
        { kind: 'assistant-text', data: { text: 'первый ход' } },
        { kind: 'turn-end', data: { isError: false } },
      ],
    });
    const book = memoryBook();
    core.seed('conv-2', book);
    const events = await run(
      new CoreChatRun({ port: core.port, book, pollMs: 1 }),
      opts({ sessionId: 'conv-2', prompt: 'дальше' }),
    );
    expect(core.estimates).toHaveLength(0);
    expect(core.calls).toEqual([
      { kind: 'message-to-step', fields: { stepId: core.stepId, text: 'дальше' } },
    ]);
    expect(core.pagesFrom).toEqual([0]);
    const texts = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['второй ход']);
    expect(events.some((e) => e.kind === 'done')).toBe(true);
  });

  describe('слово посреди хода (steer): ядро доставит его новым ходом после текущего', () => {
    // Живой шаг, ход-6 идёт; ход-7 приходит «на ходу». Ядро доставляет его только на границе хода —
    // в виде сеанса это `user-text` с шапкой доставки ПОСЛЕ конца хода-6, затем ход-7 до своего конца.
    // `wall` — часы панели и стены отправки ядра (`sentAt` в виде сеанса) для хода-6 и хода-7.
    const steered = async (
      deliver: 'after' | 'never' | 'rejected' | 'late-rejected',
      wall?: { now: () => number; sent?: [number, number] },
    ) => {
      const core = fakeCore({ hold: true });
      let refuse = (): void => undefined;
      const late = new Promise<void>((r) => (refuse = r));
      const book = memoryBook();
      core.seed('conv-s', book);
      const runner = new CoreChatRun({
        port: {
          ...core.port,
          async command(id, kind, fields) {
            const out = await core.port.command(id, kind, fields);
            if ((fields as { text?: string }).text !== 'ход-7') return out;
            if (deliver === 'late-rejected') await late;
            return deliver.endsWith('rejected')
              ? { ...out, status: 'rejected', code: 'step-ended' }
              : out;
          },
        },
        book,
        pollMs: 1,
        ...(wall ? { now: wall.now } : {}),
      });
      const sent = (i: 0 | 1): { sentAt?: number } => (wall?.sent ? { sentAt: wall.sent[i] } : {});
      const events: ChatEvent[] = [];
      const done = runner.start(opts({ sessionId: 'conv-s', prompt: 'ход-6' }), (e) =>
        events.push(e),
      );
      await vi.waitFor(() => expect(core.calls).toHaveLength(1));
      expect(runner.steer('ход-7')).toBe(true);
      await vi.waitFor(() => expect(core.calls).toHaveLength(2));
      const s = core.sessions[0]!;
      core.write(s, [
        { kind: 'user-text', data: { text: 'ход-6', ...sent(0) } },
        { kind: 'assistant-text', data: { text: 'ответ на ход-6' } },
        { kind: 'turn-end', data: { isError: false } },
      ]);
      if (deliver === 'after') {
        core.write(s, [
          {
            kind: 'user-text',
            data: {
              text: `${HUMAN_ORIGIN_MARK} Message from the human to this step:\nход-7`,
              ...sent(1),
            },
          },
          { kind: 'assistant-text', data: { text: 'ответ на ход-7' } },
          { kind: 'turn-end', data: { isError: false } },
        ]);
      }
      return { runner, events, done, core, refuse };
    };

    it('конец хода-6 не кончает прогон, пока доставленное слово не отработало свой ход', async () => {
      const { events, done } = await steered('after');
      await done;
      const texts = events
        .filter((e) => e.kind === 'text')
        .map((e) => (e as { text: string }).text);
      expect(texts).toEqual(['ответ на ход-6', 'ответ на ход-7']);
      expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
      expect(events.at(-1)?.kind).toBe('done');
    });

    it('доставленное слово — граница хода: nextTurn с самим словом между ответами (core-chat-012)', async () => {
      const { events, done } = await steered('after');
      await done;
      const flow = events
        .filter((e) => e.kind === 'text' || e.kind === 'nextTurn')
        .map((e) => (e.kind === 'text' ? e.text : `nextTurn:${e.prompt}`));
      expect(flow).toEqual(['ответ на ход-6', 'nextTurn:ход-7', 'ответ на ход-7']);
      const turn = events.find((e) => e.kind === 'nextTurn') as { at: unknown } | undefined;
      expect(typeof turn?.at).toBe('number');
    });

    // Граница хода и история чужого CLI — одни часы: история ставит ходу стену отправки ядра
    // (`sentAt`), лента прячет из неё ответы живого хода по `at` границы (`withoutLiveTurn`: ответ
    // остаётся, только если он раньше границы). Граница по часам панели (позже отправки) оставляла
    // ответ живого хода и в истории, и в пузыре — после F5 посреди хода он стоял дважды (F-01).
    it('граница хода — стена отправки ядра: перечитанная история прячет ровно ответ живого хода (F-01)', async () => {
      const SENT6 = 1_000_000;
      const SENT7 = 1_009_000;
      let clock = SENT7 + 500;
      const { events, done, core } = await steered('after', {
        now: () => clock++,
        sent: [SENT6, SENT7],
      });
      await done;
      const turn = events.find((e) => e.kind === 'nextTurn') as { at: number } | undefined;
      expect(turn?.at).toBe(SENT7);
      const page = await core.port.page(core.taskId, core.sessions[0]!, 0);
      const history = foldSessionEvents('conv-s', page.events, undefined);
      const answers = history
        .filter((m) => m.role === 'assistant')
        .map((m) => ({
          text: m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
          before: Date.parse(m.timestamp) < turn!.at,
        }));
      expect(answers).toEqual([
        { text: 'ответ на ход-6', before: true },
        { text: 'ответ на ход-7', before: false },
      ]);
    });

    it('вид сеанса без стены отправки (старое ядро) — граница по часам панели, как прежде', async () => {
      const { events, done } = await steered('after', { now: () => 4_242 });
      await done;
      const turn = events.find((e) => e.kind === 'nextTurn') as { at: number } | undefined;
      expect(turn?.at).toBe(4_242);
    });

    // Итог прогона в реестре: уведомление (Telegram, push) и планировщик конца читают накопленный
    // ответ. Без сброса на границе хода они получали оба ответа одной склейкой (core-chat-012).
    it('реестр: итог и уведомление — ответ хода слова, хвост — с границей, не склейкой (core-chat-012)', async () => {
      const core = fakeCore({ hold: true });
      const book = memoryBook();
      core.seed('conv-s', book);
      const runner = new CoreChatRun({ port: core.port, book, pollMs: 1 });
      const registry = new ChatRunRegistry(() => runner);
      const notices: RunNotice[] = [];
      registry.setNotifier((notice) => notices.push(notice));
      let finished: RunFinished | undefined;
      registry.setHandoffPlanner((done) => {
        finished = done;
        return undefined;
      });
      try {
        registry.start('chat-s', opts({ sessionId: 'conv-s', prompt: 'ход-6' }), {
          projectPath: 'C:/work/proj',
          sessionId: 'conv-s',
        });
        await vi.waitFor(() => expect(core.calls).toHaveLength(1));
        expect(registry.steer('chat-s', 'conv-s', 'ход-7')).toBe(true);
        await vi.waitFor(() => expect(core.calls).toHaveLength(2));
        core.write(core.sessions[0]!, [
          { kind: 'user-text', data: { text: 'ход-6' } },
          { kind: 'assistant-text', data: { text: 'готов' } },
          { kind: 'turn-end', data: { isError: false } },
          {
            kind: 'user-text',
            data: { text: `${HUMAN_ORIGIN_MARK} Message from the human to this step:\nход-7` },
          },
          { kind: 'assistant-text', data: { text: 'готов' } },
          { kind: 'turn-end', data: { isError: false } },
        ]);
        await vi.waitFor(() => expect(finished).toBeDefined());
        expect(finished?.answer).toBe('готов');
        expect(finished?.text).toBe('готов\n\nготов');
        expect(notices.find((notice) => notice.kind === 'done')?.answer).toBe('готов');
      } finally {
        registry.stopAll();
      }
    });

    it('слово ещё не доставлено — прогон ждёт его хода, «Остановить» остаётся у прогона', async () => {
      const { runner, events, done } = await steered('never');
      await new Promise((r) => setTimeout(r, 30));
      expect(events.some((e) => e.kind === 'done')).toBe(false);
      runner.stop();
      await done;
    });

    it('ядро слово отвергло — ждать нечего, прогон кончается на конце хода-6', async () => {
      const { events, done } = await steered('rejected');
      await done;
      expect(events.at(-1)?.kind).toBe('done');
    });

    it('отказ ядра пришёл, когда конец хода-6 уже придержан, — прогон кончается, не висит', async () => {
      const { events, done, refuse } = await steered('late-rejected');
      await new Promise((r) => setTimeout(r, 20));
      expect(events.some((e) => e.kind === 'done')).toBe(false);
      refuse();
      await done;
      expect(events.at(-1)?.kind).toBe('done');
    });

    it('после конца прогона слово «на ходу» не принимается — панель пошлёт его новым ходом', async () => {
      const { runner, done } = await steered('rejected');
      await done;
      expect(runner.steer('ход-8')).toBe(false);
    });
  });

  it('s10 G11: panel uploads go to the estimate as bytes, request is the bare text; a foreign path stays in the text', async () => {
    const uploads = mkdtempSync(join(tmpdir(), 'core-run-uploads-'));
    try {
      const png = join(uploads, 'chat-1', 'shot.png');
      mkdirSync(dirname(png), { recursive: true });
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const core = fakeCore({ turn: TURN });
      await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, uploadsRoot: uploads }),
        opts({ prompt: joinAttachments('Что на картинке?', [png, 'C:/work/proj/notes.md']) }),
      );
      expect(core.inline[0]).toEqual([{ name: 'shot.png', base64: 'iVBORw==' }]);
      expect(core.estimates[0]!.request).toBe(
        joinAttachments('Что на картинке?', ['C:/work/proj/notes.md']),
      );
      expect(core.estimates[0]!.request).not.toContain(uploads);
      expect(core.estimates[0]!.title).toBe('Что на картинке?');
    } finally {
      rmSync(uploads, { recursive: true, force: true });
    }
  });

  it('s10 G11: a live step gets each upload through the core and the message names the core copies', async () => {
    const uploads = mkdtempSync(join(tmpdir(), 'core-run-uploads-'));
    try {
      const png = join(uploads, 'chat-2', 'a.png');
      mkdirSync(dirname(png), { recursive: true });
      writeFileSync(png, Buffer.from([1, 2, 3]));
      const core = fakeCore({ turn: [{ kind: 'turn-end', data: { isError: false } }] });
      const book = memoryBook();
      core.seed('conv-a', book);
      await run(
        new CoreChatRun({ port: core.port, book, pollMs: 1, uploadsRoot: uploads }),
        opts({ sessionId: 'conv-a', prompt: joinAttachments('и эта', [png]) }),
      );
      expect(core.attached).toEqual([{ name: 'a.png', base64: 'AQID' }]);
      const sent = core.calls.find((c) => c.kind === 'message-to-step')!.fields as {
        text: string;
      };
      expect(sent.text).toBe(joinAttachments('и эта', [`CORE/${core.taskId}/attachments/1/a.png`]));
      expect(sent.text).not.toContain(uploads);
      expect(sent.text).toContain(ATTACHMENTS_MARKER);
    } finally {
      rmSync(uploads, { recursive: true, force: true });
    }
  });

  it('s10 G11: an upload the core refuses fails the turn with the core code, nothing is sent', async () => {
    const uploads = mkdtempSync(join(tmpdir(), 'core-run-uploads-'));
    try {
      const png = join(uploads, 'chat-3', 'b.png');
      mkdirSync(dirname(png), { recursive: true });
      writeFileSync(png, Buffer.from([1]));
      const core = fakeCore({
        turn: TURN,
        attach: { ok: false, code: 'attachment-invalid', message: 'not an image' },
      });
      const book = memoryBook();
      core.seed('conv-b', book);
      await expect(
        run(
          new CoreChatRun({ port: core.port, book, pollMs: 1, uploadsRoot: uploads }),
          opts({ sessionId: 'conv-b', prompt: joinAttachments('x', [png]) }),
        ),
      ).rejects.toThrow(/attachment-invalid/);
      expect(core.calls.some((c) => c.kind === 'message-to-step')).toBe(false);
    } finally {
      rmSync(uploads, { recursive: true, force: true });
    }
  });

  it('a step that refuses message-to-step falls through to a new task with resume', async () => {
    const core = fakeCore({
      turn: TURN,
      reject: { 'message-to-step': { cmdId: 'c', status: 'rejected', code: 'not-a-chat', seq: 0 } },
    });
    const book = memoryBook();
    core.seed('conv-3', book);
    await run(new CoreChatRun({ port: core.port, book, pollMs: 1 }), opts({ sessionId: 'conv-3' }));
    expect(core.estimates[0]!.resume).toEqual({ adapter: 'claude', conversationId: 'conv-3' });
  });

  it('model and effort go to the core as set-model before launch', async () => {
    const core = fakeCore({ turn: TURN });
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts({ model: 'opus', effort: 'high' }),
    );
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'set-model', 'launch']);
    expect(core.calls[1]!.fields).toEqual({
      scope: 'task',
      scopeId: core.taskId,
      model: 'opus',
      effort: 'high',
      timing: 'now',
    });
  });

  it('contour route of the «Чат» consumer goes to the core as set-route before set-cli', async () => {
    const core = fakeCore({ turn: TURN });
    const routes = [
      {
        adapter: 'claude',
        route: { kind: 'gateway' as const, id: 'gateway:qa-contour' },
        modelPattern: 'stub-chat',
      },
    ];
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, routes: () => routes }),
      opts(),
    );
    expect(core.calls.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'launch']);
    expect(core.calls[0]!.fields).toEqual({
      scope: 'task',
      scopeId: core.taskId,
      allowedRoutes: routes,
    });
  });

  // s10 G7: под обязательным контуром ядро судит `set-model` шаблоном маршрута; имя вендора из
  // выбора чата под шаблоном контура — отказ всего хода. Шлётся перевод контуром, без усилия.
  it('contour route with an exact model: set-model sends the contour model, no effort; routes get the pick', async () => {
    const core = fakeCore({ turn: TURN });
    const asked: string[] = [];
    const routes = (pick: string) => {
      asked.push(pick);
      return [
        {
          adapter: 'claude',
          route: { kind: 'gateway' as const, id: 'gateway:qa-contour' },
          modelPattern: 'corp-xl',
        },
      ];
    };
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, routes }),
      opts({ model: 'opus', effort: 'high' }),
    );
    expect(asked).toEqual(['opus']);
    expect(core.calls.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'set-model', 'launch']);
    expect(core.calls[2]!.fields).toEqual({
      scope: 'task',
      scopeId: core.taskId,
      model: 'corp-xl',
      effort: null,
      timing: 'now',
    });
  });

  it('contour route without a model ("*") — the pick and its effort go as chosen', async () => {
    const core = fakeCore({ turn: TURN });
    const routes = () => [
      {
        adapter: 'claude',
        route: { kind: 'gateway' as const, id: 'gateway:qa-contour' },
        modelPattern: '*',
      },
    ];
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, routes }),
      opts({ model: 'opus', effort: 'high' }),
    );
    expect(core.calls[2]!.fields).toMatchObject({ model: 'opus', effort: 'high' });
  });

  // W3-17a: своего выбора CLI у чата нет — новый разговор идёт активным провайдером панели, начатый
  // — тем CLI, которым начат (книга), даже если активный провайдер с тех пор сменился.
  describe('W3-17a: the chat CLI — the active provider for a new chat, its own for a started one', () => {
    const gateway = (cli: string, model = 'corp-xl') => [
      {
        adapter: cli,
        route: { kind: 'gateway' as const, id: 'gateway:qa-contour' },
        modelPattern: model,
      },
    ];

    it('active codex: a new chat sets cli codex, the contour route is asked for codex, the book records codex', async () => {
      const core = fakeCore({ turn: TURN });
      const book = memoryBook();
      const asked: Array<[string, string]> = [];
      const carried: string[] = [];
      await run(
        new CoreChatRun({
          port: core.port,
          book,
          pollMs: 1,
          activeCli: () => 'codex',
          routes: (pick, cli) => {
            asked.push([pick, cli]);
            return gateway(cli);
          },
          foreignCarry: ({ cli, routes }) => {
            carried.push(`${cli}:${routes?.[0]?.adapter ?? '-'}`);
            return { ok: true, carry: { session: {}, env: {} } };
          },
        }),
        opts({ model: 'gpt-5-codex', effort: 'high' }),
      );
      expect(asked).toEqual([['gpt-5-codex', 'codex']]);
      expect(carried).toEqual(['codex:codex']);
      expect(core.calls.map((c) => c.kind)).toEqual([
        'set-route',
        'set-cli',
        'set-model',
        'launch',
      ]);
      expect(core.calls[1]!.fields).toMatchObject({ adapter: 'codex' });
      expect(core.calls[0]!.fields).toMatchObject({ allowedRoutes: gateway('codex') });
      expect(book.cliOf(core.sessions[0]!)).toBe('codex');
    });

    it('a chat recorded as codex resumes on codex while Claude is active; the Claude header model is not sent', async () => {
      const core = fakeCore({ turn: TURN });
      const book = memoryBook();
      // Разговор начат Codex, его задача кончилась: книга помнит только CLI.
      book.set('conv-codex', { taskId: 'old-task', stepId: 'old-step', cli: 'codex' });
      book.forget('conv-codex');
      const asked: Array<[string, string]> = [];
      await run(
        new CoreChatRun({
          port: core.port,
          book,
          pollMs: 1,
          activeCli: () => 'claude',
          routes: (pick, cli) => {
            asked.push([pick, cli]);
            return undefined;
          },
        }),
        opts({ sessionId: 'conv-codex', model: 'opus', effort: 'high' }),
      );
      expect(core.estimates[0]!.resume).toEqual({ adapter: 'codex', conversationId: 'conv-codex' });
      // Контур спрашивается выбором как есть (его перевод, M-F1); маршрута контура нет — до CLI имя
      // Claude не доходит.
      expect(asked).toEqual([['opus', 'codex']]);
      expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
      expect(core.calls[0]!.fields).toMatchObject({ adapter: 'codex' });
      expect(book.entries.get('conv-codex')).toMatchObject({ taskId: core.taskId, cli: 'codex' });
    });

    // Шапка нового чата при активном Qwen несла модель Claude из настроек (`chatModel`): ядро
    // получало `set-model opus` для qwen. Мимо контура имя Claude другому CLI не уходит — модель
    // маршрута; контур спрашивается выбором как есть (переводит он, M-F1).
    it.each(['opus', 'fable', 'claude-opus-4-8[1m]', 'Sonnet'])(
      'active qwen, new chat, header model %s (Claude), no contour → no set-model',
      async (model) => {
        const core = fakeCore({ turn: TURN });
        const asked: Array<[string, string]> = [];
        await run(
          new CoreChatRun({
            port: core.port,
            book: memoryBook(),
            pollMs: 1,
            activeCli: () => 'qwen',
            routes: (pick, cli) => {
              asked.push([pick, cli]);
              return undefined;
            },
          }),
          opts({ model, effort: 'high' }),
        );
        expect(asked).toEqual([[model, 'qwen']]);
        expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
        expect(core.calls[0]!.fields).toMatchObject({ adapter: 'qwen' });
      },
    );

    it('a started codex chat while Claude is active: the codex model of its header reaches set-model', async () => {
      const core = fakeCore({ turn: TURN });
      const book = memoryBook();
      book.set('conv-codex', { taskId: 'old-task', stepId: 'old-step', cli: 'codex' });
      book.forget('conv-codex');
      await run(
        new CoreChatRun({ port: core.port, book, pollMs: 1, activeCli: () => 'claude' }),
        opts({ sessionId: 'conv-codex', model: 'gpt-5-codex', effort: 'high' }),
      );
      expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'set-model', 'launch']);
      expect(core.calls[1]!.fields).toMatchObject({ model: 'gpt-5-codex', effort: 'high' });
    });

    // Ревью W3-17a (M-F1): через контур модель — имя КОНТУРА (его каталог одинаков у любого CLI и
    // несёт `claude-*`), и CLI его не видит: шлёт `set-model` перевод контура. Срезанный до контура
    // выбор `claude-sonnet-4-5` чата qwen уходил моделью контура по умолчанию, выбор человека терялся.
    it('active qwen through a contour: a claude-* model of the contour catalog reaches the contour and set-model', async () => {
      const core = fakeCore({ turn: TURN });
      const asked: Array<[string, string]> = [];
      await run(
        new CoreChatRun({
          port: core.port,
          book: memoryBook(),
          pollMs: 1,
          activeCli: () => 'qwen',
          routes: (pick, cli) => {
            asked.push([pick, cli]);
            return gateway(cli, pick === 'claude-sonnet-4-5' ? 'claude-sonnet-4-5' : 'corp-xl');
          },
        }),
        opts({ model: 'claude-sonnet-4-5', effort: 'high' }),
      );
      expect(asked).toEqual([['claude-sonnet-4-5', 'qwen']]);
      expect(core.calls.map((c) => c.kind)).toEqual([
        'set-route',
        'set-cli',
        'set-model',
        'launch',
      ]);
      expect(core.calls[2]!.fields).toMatchObject({ model: 'claude-sonnet-4-5', effort: null });
    });

    // Контур без своей модели (`*`): имя уходит CLI как есть — тут правило «имя Claude другому CLI
    // не уходит» в силе, как и на маршруте входа CLI.
    it('active qwen, contour route without a model ("*"): a Claude name is still not sent', async () => {
      const core = fakeCore({ turn: TURN });
      await run(
        new CoreChatRun({
          port: core.port,
          book: memoryBook(),
          pollMs: 1,
          activeCli: () => 'qwen',
          routes: (_pick, cli) => gateway(cli, '*'),
        }),
        opts({ model: 'claude-sonnet-4-5', effort: 'high' }),
      );
      expect(core.calls.map((c) => c.kind)).toEqual(['set-route', 'set-cli', 'launch']);
    });

    // Ревью W3-17a (M-F1), настоящая дорога сервера: живой стаб-контур (`stub-platform.mjs`) каталога
    // `claude-*` не несёт — его каталог фиксирован, а модель вне каталога ядро отказывает судом
    // совместимости. Потому дорога «каталог контура несёт claude-*» доказана здесь: настоящее
    // хранилище с активным контуром, настоящий перевод выбора (`chooseRunModel` по
    // `modelRulesFor` — его делает реестр прогонов до хода) и настоящие `chatContourRoutes` (как в
    // `chat-wiring.ts`) зависимостью хода; подменён только порт ядра. Контур «по возможности», стоит
    // галочка самого qwen (`foreign:qwen`) — её и судит маршрут чата этого CLI.
    it('active qwen, real contour store whose catalog carries claude-*: the pick reaches set-route and set-model', async () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-core-run-contour-'));
      try {
        const dir = join(root, 'agentdeck');
        mkdirSync(dir, { recursive: true });
        const store = new AppStore(dir);
        const platform: Platform = {
          id: 'company',
          title: 'Company',
          driver: 'enterprise-platform',
          baseUrl: 'https://api.example.com',
          enabled: true,
          mode: 'best-effort',
          budgetUsd: 0,
          capabilities: [],
          targets: [],
          consumers: ['foreign:qwen'],
          projectPaths: [],
          agents: [],
          budgetSince: '',
          toolShim: false,
          contourPrompt: false,
          defaultModel: 'corp-xl',
          consumerModels: {},
          modelMap: {},
          rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
          caCertPath: '',
          transport: defaultPlatformTransport(),
        };
        writePlatform(store, platform);
        store.updateSettings({ activePlatformId: platform.id });
        store.savePlatformHealth(platform.id, {
          ok: true,
          checkedAt: '2026-11-06T10:00:00.000Z',
          models: [
            { id: 'corp-xl', kind: 'chat' },
            { id: 'claude-sonnet-5-5', kind: 'chat' },
          ],
        } as never);
        const routed = chooseRunModel(
          modelRulesFor(store, platform, 'chat'),
          'claude-sonnet-5-5',
        ).model;
        const core = fakeCore({ turn: TURN });
        await run(
          new CoreChatRun({
            port: core.port,
            book: memoryBook(),
            pollMs: 1,
            activeCli: () => 'qwen',
            routes: (pick, cli) => chatContourRoutes(store, cli, pick),
          }),
          opts({ model: routed, effort: 'high' }),
        );
        expect(routed).toBe('claude-sonnet-5-5');
        expect(core.calls.map((c) => c.kind)).toEqual([
          'set-route',
          'set-cli',
          'set-model',
          'launch',
        ]);
        expect(core.calls[0]!.fields).toMatchObject({
          allowedRoutes: [
            {
              adapter: 'qwen',
              route: { kind: 'gateway', id: coreGatewayRouteId('company') },
              modelPattern: 'claude-sonnet-5-5',
            },
          ],
        });
        expect(core.calls[2]!.fields).toMatchObject({ model: 'claude-sonnet-5-5', effort: null });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('a Claude chat keeps its Claude model whatever provider is active', async () => {
      const core = fakeCore({ turn: TURN });
      const book = memoryBook();
      book.set('conv-claude', { taskId: 'old-task', stepId: 'old-step', cli: 'claude' });
      book.forget('conv-claude');
      await run(
        new CoreChatRun({ port: core.port, book, pollMs: 1, activeCli: () => 'qwen' }),
        opts({ sessionId: 'conv-claude', model: 'opus', effort: 'high' }),
      );
      expect(core.calls[0]!.fields).toMatchObject({ adapter: 'claude' });
      expect(core.calls[1]!.fields).toMatchObject({ model: 'opus' });
    });

    it('an old book entry without a CLI resumes on claude even when another provider is active', async () => {
      const core = fakeCore({ turn: TURN });
      await run(
        new CoreChatRun({
          port: core.port,
          book: memoryBook(),
          pollMs: 1,
          activeCli: () => 'qwen',
        }),
        opts({ sessionId: 'conv-old' }),
      );
      expect(core.estimates[0]!.resume).toEqual({ adapter: 'claude', conversationId: 'conv-old' });
      expect(core.calls[0]!.fields).toMatchObject({ adapter: 'claude' });
    });

    it('a foreign CLI gets its own panel layer, never the Claude layer of the run options', async () => {
      const core = fakeCore({ turn: TURN });
      await run(
        new CoreChatRun({
          port: core.port,
          book: memoryBook(),
          pollMs: 1,
          activeCli: () => 'qwen',
          foreignCarry: () => ({
            ok: true,
            carry: { session: { append: 'строка о тестах qwen' }, env: {} },
          }),
        }),
        opts({ platformAppend: 'блок набора Claude' }),
      );
      expect(core.estimates[0]!.session).toEqual({ append: 'строка о тестах qwen' });
    });
  });

  it('no contour route (no active contour or box unticked in best-effort) — no set-route', async () => {
    const core = fakeCore({ turn: TURN });
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, routes: () => undefined }),
      opts(),
    );
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
  });

  // s10 G12 p7: задачи нет (или она тут же кончилась) — журнала, куда отсылал общий текст, человек
  // не откроет; причина ядра едет в самом тексте, код рядом — клиент переводит шапку своим словарём.
  it('core refusal of the estimate carries the core reason in the text and nothing is launched', async () => {
    const reason = 'C:\\w\\app: base default branch not found';
    const core = fakeCore({
      estimate: { ok: false, code: 'estimate-refused', message: reason },
    });
    const failed = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts(),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failed!.message).toBe(
      serverText('core-chat-estimate-refused', { code: 'estimate-refused', reason }),
    );
    expect(failed!.message).not.toContain('журнале');
    expect(runErrorCode(failed!.message)).toEqual({
      code: 'core-chat-estimate-refused',
      params: { code: 'estimate-refused', reason },
      panel: true,
    });
    expect(localizeText(failed!.message, 'en')).toBe(
      `The turn was not sent: the task core did not accept it (code estimate-refused). Core reason: ${reason}`,
    );
    expect(core.calls).toEqual([]);
  });

  it('s10 G7: a required contour refused by the core reaches the chat as a coded panel text; the core words stay in the cause', async () => {
    const core = fakeCore({
      reject: {
        'set-route': {
          cmdId: 'c',
          status: 'rejected',
          code: 'route_unavailable',
          reason:
            'contour c1 is required and its gateway is down; the vendor cloud is never taken instead',
          seq: 0,
        },
      },
    });
    const routes = [
      {
        adapter: 'claude',
        route: { kind: 'gateway' as const, id: 'gateway:c1' },
        modelPattern: '*',
      },
    ];
    const failed = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1, routes: () => routes }),
      opts(),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed!.message).toBe(serverText('core-chat-contour-down', { contour: 'c1' }));
    expect(String((failed!.cause as Error).message)).toContain(
      'set-route refused (route_unavailable)',
    );
    // Поток SSE: код рядом с текстом — клиент показывает перевод на языке интерфейса.
    expect(runErrorCode(failed!.message)).toEqual({
      code: 'core-chat-contour-down',
      params: { contour: 'c1' },
      panel: true,
    });
    expect(localizeText(failed!.message, 'en')).toContain('the required contour c1 is unavailable');
  });

  it('s10 G7: «needs a concrete model» from the core is the coded model text, not the core English', async () => {
    const core = fakeCore({
      reject: {
        launch: {
          cmdId: 'c',
          status: 'rejected',
          code: 'session-refused',
          reason:
            'session road refused: route gateway:c1 needs a concrete model; the tier picked the CLI default',
          seq: 0,
        },
      },
    });
    const failed = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts(),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failed!.message).toBe(serverText('core-chat-model-needed', { route: 'gateway:c1' }));
    expect(runErrorCode(failed!.message)).toMatchObject({
      code: 'core-chat-model-needed',
      panel: true,
    });
  });

  // s10 G12: контур не открыл ключу модель (`compatRefusalReason`, ядро называет модель) — свой
  // код панели «модель X недоступна в контуре Y» и что делать, а не общий «код …» со словами ядра.
  // Причины — дословно те, что ядро пишет: отказ команды запуска и шаг, исчерпавший попытки.
  describe('s10 G12: contour model refusal by panel code', () => {
    const ABSENT =
      'session road refused: compat refused: model_absent: model qwen2.5:7b is not in the model list of route gateway:c1';
    it.each([
      [
        'launch rejected',
        {
          reject: {
            launch: {
              cmdId: 'c',
              status: 'rejected' as const,
              code: 'session-refused',
              reason: ABSENT,
              seq: 0,
            },
          },
        },
      ],
      ['step failed', { stepFailed: `no-outcome: session refused 3 times: ${ABSENT}` }],
    ])('%s → core-chat-contour-model with model and contour', async (_how, fake) => {
      const core = fakeCore(fake);
      const failed = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts(),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failed!.message).toBe(
        serverText('core-chat-contour-model', { model: 'qwen2.5:7b', contour: 'c1' }),
      );
      expect(runErrorCode(failed!.message)).toEqual({
        code: 'core-chat-contour-model',
        params: { model: 'qwen2.5:7b', contour: 'c1' },
        panel: true,
      });
      expect(localizeText(failed!.message, 'en')).toContain(
        'model qwen2.5:7b is not available in contour c1',
      );
    });

    it('model_absent on a route that is not a contour stays the generic coded text', async () => {
      const core = fakeCore({
        stepFailed:
          'session road refused: compat refused: model_absent: model m1 is not in the model list of route cli-login:claude',
      });
      const failed = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts(),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(runErrorCode(failed!.message)).toMatchObject({ code: 'core-chat-refused' });
    });

    // W3-17a: CLI без хука ядра (aider, continue) — экран чата объясняет код суда своей строкой;
    // код в ошибке хода — код суда, а не исход шага `failed`.
    it('a compat refusal carries the court code (no_core_hook), not the step outcome', async () => {
      const core = fakeCore({ stepFailed: 'session road refused: compat refused: no_core_hook' });
      const failed = await run(
        new CoreChatRun({
          port: core.port,
          book: memoryBook(),
          pollMs: 1,
          activeCli: () => 'aider',
        }),
        opts(),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(core.calls[0]!.fields).toMatchObject({ adapter: 'aider' });
      expect(runErrorCode(failed!.message)).toEqual({
        code: 'core-chat-refused',
        params: { code: 'no_core_hook' },
        panel: true,
      });
    });
  });

  // s10 G13: отказ переноса набора в сеанс — причина и выход кодом панели, а не «код failed».
  // Причины — дословно те, что пишет ядро (`road.ts` + `plugin-carry.ts` / `session-carry-gate.ts`).
  describe('s10 G13: kit carry refusal by panel code', () => {
    it.each([
      [
        "process-start failed: launch-refused: session-carry-plugin: plugin declares MCP servers (.mcp.json), outside the session's strict MCP list: C:\\data\\kit\\effective\\ours\\agentdeck-kit",
        'core-chat-kit-mcp',
        { path: 'C:\\data\\kit\\effective\\ours\\agentdeck-kit' },
        'declares MCP servers',
      ],
      [
        'process-start failed: launch-refused: session-carry-plugin: plugin dir missing: C:\\data\\kit\\guards',
        'core-chat-kit-missing',
        { path: 'C:\\data\\kit\\guards' },
        'could not find or read the kit folder',
      ],
      [
        "session road refused: session-carry-plugins-without-hooks: plugins carry hooks, the step runs hooks 'observe' — a plugin would bypass the step's hook mode",
        'core-chat-kit-hooks',
        { mode: 'observe' },
        'runs your layer’s hooks as «observe»',
      ],
      [
        "process-start failed: launch-refused: session-carry-needs-layer-on: plugins and setting sources ride the human layer, this step runs it 'off' by its own mode",
        'core-chat-kit-hooks',
        { mode: 'off' },
        'runs your layer’s hooks as «off»',
      ],
    ] as const)('s10 G13: step failed with %s → %s', async (reason, code, params, english) => {
      const core = fakeCore({ stepFailed: reason });
      const failed = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts(),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failed!.message).toBe(serverText(code, params));
      expect(runErrorCode(failed!.message)).toEqual({ code, params, panel: true });
      expect(localizeText(failed!.message, 'en')).toContain(english);
    });
  });

  // s10 G14 p7: отказ локального слоя и CLI без поля переноса — текстом панели с выходом, на языке
  // интерфейса; строка ядра `session-carry-*` в чат сырой не уходит. Причины — дословно ядра
  // (`local-layer-carry.ts`, `session-carry-gate.ts`; их разбор закреплён и в тесте ядра).
  describe('s10 G14 p7: local-layer carry refusal by panel code', () => {
    it.each([
      [
        "process-start failed: launch-refused: session-carry-local-layer-needs-layer-on: the project layer is repository content, this step runs the human layer 'observe' (folder not trusted)",
        'core-chat-layer-untrusted',
        {},
        'Claude Code does not trust the folder',
      ],
      [
        "process-start failed: launch-refused: session-carry-local-layer-needs-layer-on: the project layer is repository content, this step runs the human layer 'off'",
        'core-chat-layer-mode',
        { mode: 'off' },
        'runs your configuration layer as «off»',
      ],
      [
        'process-start failed: launch-refused: session-carry-local-layer-with-project: the local layer replaces the project setting source, the session must narrow setting sources without project',
        'core-chat-layer-sources',
        {},
        'This is a panel fault',
      ],
      [
        'process-start failed: launch-refused: session-carry-local-layer-plugin: plugin dir missing: C:\\w\\app\\.agent\\local-layer\\build\\plugin',
        'core-chat-layer-build',
        { path: 'C:\\w\\app\\.agent\\local-layer\\build\\plugin' },
        'could not use the local layer build',
      ],
      [
        'session road refused: session-carry-unsupported: adapter qwen cannot carry settingSources, localLayer — start the chat in a CLI that does, or drop the field',
        'core-chat-carry-unsupported',
        { adapter: 'qwen', fields: 'settingSources, localLayer' },
        'the qwen CLI cannot take part of the panel layer',
      ],
    ] as const)('s10 G14 p7: step failed with %s → %s', async (reason, code, params, english) => {
      const core = fakeCore({ stepFailed: reason });
      const failed = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts(),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failed!.message).toBe(serverText(code, params));
      expect(failed!.message).not.toContain('session-carry-');
      expect(runErrorCode(failed!.message)).toEqual({ code, params, panel: true });
      expect(localizeText(failed!.message, 'en')).toContain(english);
    });

    it('s10 G14 p7: a local layer too big for the core session is named before any core call', async () => {
      const core = fakeCore({ turn: TURN });
      const failed = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts({ localLayer: { instructions: 'x'.repeat(LOCAL_LAYER_INSTRUCTIONS_MAX + 1) } }),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failed!.message).toBe(serverText('core-chat-layer-fit', { field: 'instructions' }));
      expect(runErrorCode(failed!.message)).toEqual({
        code: 'core-chat-layer-fit',
        params: { field: 'instructions' },
        panel: true,
      });
      expect(localizeText(failed!.message, 'en')).toContain('does not fit the core session');
    });
  });

  it('G6: tests line, profile line, kit block, our-layer flags and kit env reach the core as typed session fields; env values only in the estimate body', async () => {
    const core = fakeCore({ turn: TURN });
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts({
        appendSystemPrompt: 'PANEL_OWN_APPEND',
        workspaceNote: 'TESTS_LINE',
        profileNote: 'PROFILE_LINE',
        platformAppend: 'KIT_BLOCK',
        platformArgs: [
          '--plugin-dir',
          'C:/kits/rules',
          '--setting-sources',
          'project,local',
          '--setting-sources',
          'local,user',
          '--disable-slash-commands',
          '--strict-mcp-config',
          '--tools',
          'Read,Grep,Bash',
          '--exclude-dynamic-system-prompt-sections',
        ],
        platformEnv: {
          AGENTDECK_KIT_VARIANT: 'light',
          BASH_MAX_OUTPUT_LENGTH: '8000',
          ANTHROPIC_BASE_URL: 'http://contour.example:9',
          ANTHROPIC_API_KEY: 'sk-contour-secret',
        },
      }),
    );
    expect(core.estimates[0]!.session).toEqual({
      append: 'TESTS_LINE\n\nPROFILE_LINE\n\nKIT_BLOCK',
      plugins: ['C:/kits/rules'],
      // Два слоя сужают источники — пересечение.
      settingSources: ['local'],
      skills: 'off',
      mcp: 'core',
      builtinTools: ['Read', 'Grep', 'Bash'],
      env: ['AGENTDECK_TESTS_NOTE', 'AGENTDECK_KIT_VARIANT', 'BASH_MAX_OUTPUT_LENGTH'],
    });
    expect(core.envs[0]).toEqual({
      AGENTDECK_TESTS_NOTE: '1',
      AGENTDECK_KIT_VARIANT: 'light',
      BASH_MAX_OUTPUT_LENGTH: '8000',
    });
    // Значения переменных и адрес/ключ контура — не в полях оценки (журнал ядра).
    const fields = JSON.stringify(core.estimates[0]);
    expect(fields).not.toContain('light');
    expect(fields).not.toContain('sk-contour-secret');
    expect(fields).not.toContain('PANEL_OWN_APPEND');
  });

  it('G6: the system-prompt layer drops the tests and profile lines, the kit block stays', async () => {
    const core = fakeCore({ turn: TURN });
    await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts({
        workspaceNote: 'TESTS_LINE',
        profileNote: 'PROFILE_LINE',
        platformAppend: 'KIT_BLOCK',
        platformDropAppend: true,
      }),
    );
    expect(core.estimates[0]!.session?.append).toBe('KIT_BLOCK');
  });

  it.each([
    ['--settings', ['--settings', 'C:/x/settings.json']],
    ['--permission-mode', ['--permission-mode', 'bypassPermissions']],
    ['--mcp-config', ['--mcp-config', 'C:/x/mcp.json']],
    ['--dangerously-skip-permissions', ['--dangerously-skip-permissions']],
  ])(
    'G6: panel flag %s has no core session field — the turn is refused by name, nothing reaches the core',
    async (flag, platformArgs) => {
      const core = fakeCore({ turn: TURN });
      await expect(
        run(
          new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
          opts({ platformArgs }),
        ),
      ).rejects.toThrow(
        `core chat: the panel layer does not fit the core session: panel flag ${flag} has no core session field`,
      );
      expect(core.estimates).toEqual([]);
      expect(core.calls).toEqual([]);
    },
  );

  it('core not running is a named error, no fallback to the old runner', async () => {
    const core = fakeCore({ estimate: new Error('core is not running: no procs.json') });
    await expect(
      run(new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }), opts()),
    ).rejects.toThrow('core chat: core is not running: no procs.json');
  });

  it('a refused set-cli cancels the task and names the code', async () => {
    const core = fakeCore({
      reject: {
        'set-cli': { cmdId: 'c', status: 'rejected', code: 'no-adapter', reason: 'x', seq: 0 },
      },
    });
    await expect(
      run(new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }), opts()),
    ).rejects.toThrow(serverText('core-chat-refused', { code: 'no-adapter' }));
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'cancel']);
  });

  it('stop cancels the core task with a reason, forgets the book entry, start resolves quietly', async () => {
    const core = fakeCore({ turn: [{ kind: 'assistant-text', data: { text: 'долго' } }] });
    const book = memoryBook();
    const chat = new CoreChatRun({ port: core.port, book, pollMs: 1 });
    const events: ChatEvent[] = [];
    const done = chat.start(opts(), (e) => events.push(e));
    await expect.poll(() => events.some((e) => e.kind === 'text')).toBe(true);
    chat.stop();
    await expect(done).resolves.toBeUndefined();
    expect(core.calls.at(-1)).toEqual({
      kind: 'cancel',
      fields: { reason: CORE_CHAT_STOP_REASON },
    });
    expect(book.entries.size).toBe(0);
    expect(events.some((e) => e.kind === 'done' || e.kind === 'error')).toBe(false);
  });

  it('a turn that ends with an error shows the error before done', async () => {
    const core = fakeCore({ turn: [{ kind: 'turn-end', data: { isError: true } }] });
    const events = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts(),
    );
    expect(events.slice(-2).map((e) => e.kind)).toEqual(['error', 'done']);
    expect(events.at(-2)).toEqual({ kind: 'error', message: TURN_ERROR_TEXT });
  });

  describe('слова CLI при ошибке хода', () => {
    it('a turn that ends with the CLI words carries them: a known CLI error gets its panel code', async () => {
      const core = fakeCore({
        turn: [
          { kind: 'turn-end', data: { isError: true, numTurns: 1, text: 'Prompt is too long' } },
        ],
      });
      const events = await run(
        new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
        opts(),
      );
      expect(events.at(-2)).toEqual({ kind: 'error', message: 'Prompt is too long' });
      expect(runErrorCode('Prompt is too long')).toMatchObject({ code: 'prompt-too-long' });
    });

    it('the CLI words travel only with an error turn; an empty text is no words', () => {
      const end = (data: Record<string, unknown>) =>
        translate({ kind: 'turn-end', data, offset: 1 } as SessionStreamEvent);
      expect(end({ isError: false, text: 'итог хода' })).toEqual({
        kind: 'turn-end',
        isError: false,
      });
      expect(end({ isError: true, text: '  ' })).toEqual({ kind: 'turn-end', isError: true });
      expect(end({ isError: true, text: ' 529 overloaded ' })).toEqual({
        kind: 'turn-end',
        isError: true,
        text: '529 overloaded',
      });
    });
  });

  it('session ended mid-turn: the turn continues on the next session of the same step', async () => {
    const core = fakeCore({ turn: TURN, restart: true });
    const events = await run(
      new CoreChatRun({ port: core.port, book: memoryBook(), pollMs: 1 }),
      opts(),
    );
    const texts = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['half', 'Смотрю ', 'код.']);
    expect(events.at(-1)?.kind).toBe('done');
  });

  it.each([
    ['fork', { fork: true }, /fork/],
    ['keep-warm ping', { ephemeral: true }, /keep-warm/],
    ['CLI-started turn', { wake: true }, /started by the CLI/],
  ] as const)('%s has no core path: named refusal, core untouched', async (_n, over, why) => {
    const core = fakeCore();
    await expect(
      run(new CoreChatRun({ port: core.port, book: memoryBook() }), opts(over)),
    ).rejects.toThrow(why);
    expect(core.estimates).toHaveLength(0);
    expect(core.calls).toHaveLength(0);
  });

  describe('permits', () => {
    const line = (
      seq: number,
      kind: string,
      data: unknown,
      extra: Partial<JournalLine> = {},
    ): JournalLine =>
      ({
        v: 1,
        seq,
        at: 0,
        mono: 0,
        bootId: 'b',
        taskId: 't',
        kind,
        actor: 'core',
        data,
        ...extra,
      }) as unknown as JournalLine;

    /**
     * Журнал задачи как его пишет ядро (`conductor/human/raise.ts`): единица с ключом репозитория,
     * шаг на ней, решение права с полной целью отказа (строка 8), за ним решение пункта человека
     * (строка 9, цели в нём нет) и вопрос пункта 5 с причиной — строкой 9, не 8.
     */
    const permitJournal = (stepId: string, askId: string, target: string): JournalLine[] => [
      line(3, 'unit.created', { unitId: 'u-1', repoKey: 'repo-abc' }),
      line(4, 'step.started', { stepId, unitId: 'u-1' }),
      line(8, 'decision', { class: 'permit', output: { allow: false, target } }, {
        stepId,
        sessionId: 's-1',
      } as Partial<JournalLine>),
      line(
        9,
        'decision',
        { class: 'human-point', output: { source: 'permit', point: 5, blocking: true } },
        { stepId, sessionId: 's-1' } as Partial<JournalLine>,
      ),
      line(
        10,
        'human.asked',
        {
          askId,
          point: 5,
          source: 'permit',
          dedupe: null,
          question: 'The step needs a grant to edit src/x.ts',
          options: ['grant', 'refuse'],
          defaultAction: null,
        },
        { stepId, sessionId: 's-1', cause: 9 } as Partial<JournalLine>,
      ),
    ];

    async function permitRun(askState = 'open', target = 'C:\\work\\proj\\src\\x.ts') {
      const askId = randomUUID7();
      const core = fakeCore({ hold: true, askState });
      const requests: unknown[] = [];
      const settled: unknown[] = [];
      let answer: (text: string) => void = () => undefined;
      const answered = new Promise<string>((resolve) => (answer = resolve));
      const desk: CorePermissionDesk = {
        request: (runId, card) => {
          requests.push({ runId, card });
          return new Promise(() => undefined);
        },
        settle: (runId, toolUseId, reply) => void settled.push({ runId, toolUseId, reply }),
      };
      // Строка журнала несёт шаг этой задачи: вопрос права чужого шага карточки не даёт.
      const port: CoreChatPort = {
        ...core.port,
        async *taskEvents(t, signal) {
          yield* permitJournal(core.stepId, askId, target);
          const text = await answered;
          yield line(12, 'human.answered', { askId, answer: text });
          yield* core.port.taskEvents(t, signal);
        },
        async view(id) {
          const v = await core.port.view(id);
          return v ? ({ ...v, asks: [{ askId, state: askState }] } as TaskView) : v;
        },
      };
      const chat = new CoreChatRun({ port, book: memoryBook(), desk, pollMs: 1 });
      const events: ChatEvent[] = [];
      const done = chat.start(
        opts({ permissionPrompt: { runId: 'run-1', baseUrl: 'http://x' } }),
        (e) => events.push(e),
      );
      return { askId, core, requests, settled, events, chat, done, answer };
    }

    it('permit ask → card with the core facts the browser needs; the server never answers the core', async () => {
      const r = await permitRun();
      await expect.poll(() => r.requests.length).toBe(1);
      expect(r.requests).toEqual([
        {
          runId: 'run-1',
          // Поля ядра едут и брокеру: из него сводку собирают «Вопросы» телефона (G9).
          card: {
            toolName: 'core-permit',
            input: { question: 'The step needs a grant to edit src/x.ts' },
            toolUseId: r.askId,
            core: {
              taskId: r.core.taskId,
              askId: r.askId,
              point: 5,
              options: ['grant', 'refuse'],
              project: 'repo-abc',
              globs: ['src/x.ts'],
            },
          },
        },
      ]);
      expect(r.events.find((e) => e.kind === 'coreTask')).toEqual({
        kind: 'coreTask',
        taskId: r.core.taskId,
        project: 'repo-abc',
      });
      const card = r.events.find((e) => e.kind === 'permission');
      expect(card).toMatchObject({
        toolUseId: r.askId,
        core: {
          taskId: r.core.taskId,
          askId: r.askId,
          point: 5,
          options: ['grant', 'refuse'],
          project: 'repo-abc',
          globs: ['src/x.ts'],
        },
      });
      await new Promise((res) => setTimeout(res, 30));
      // Ответ `answer` — human-strict: сервер его не шлёт, ни сам, ни по авторежиму.
      expect(r.core.calls.some((c) => c.kind === 'answer' || c.kind === 'grant')).toBe(false);
      r.chat.stop();
      await r.done;
    });

    it('the answer the core recorded (grant) settles the card and the desk', async () => {
      const r = await permitRun();
      await expect.poll(() => r.requests.length).toBe(1);
      r.answer('grant');
      await expect.poll(() => r.events.some((e) => e.kind === 'permissionResolved')).toBe(true);
      expect(r.events.find((e) => e.kind === 'permissionResolved')).toEqual({
        kind: 'permissionResolved',
        toolUseId: r.askId,
        behavior: 'allow',
      });
      expect(r.settled).toEqual([
        { runId: 'run-1', toolUseId: r.askId, reply: { behavior: 'allow' } },
      ]);
      r.chat.stop();
      await r.done;
    });

    it('a recorded refuse settles the card as deny', async () => {
      const r = await permitRun();
      await expect.poll(() => r.requests.length).toBe(1);
      r.answer('refuse');
      await expect.poll(() => r.settled.length).toBe(1);
      expect(r.settled[0]).toEqual({
        runId: 'run-1',
        toolUseId: r.askId,
        reply: { behavior: 'deny' },
      });
      r.chat.stop();
      await r.done;
    });

    it('a target outside the copy root gives no glob (the browser says no grant), never a full-path mask', async () => {
      const r = await permitRun('open', 'D:\\elsewhere\\x.ts');
      await expect.poll(() => r.requests.length).toBe(1);
      expect(r.events.find((e) => e.kind === 'permission')).toMatchObject({
        core: { globs: [] },
      });
      r.chat.stop();
      await r.done;
    });

    it('an ask already answered in the core (journal replay) gets no card', async () => {
      const r = await permitRun('answered');
      await expect.poll(() => r.events.some((e) => e.kind === 'session')).toBe(true);
      await new Promise((res) => setTimeout(res, 30));
      expect(r.requests).toEqual([]);
      expect(r.events.some((e) => e.kind === 'permission')).toBe(false);
      r.chat.stop();
      await r.done;
    });
  });

  describe('grantGlob', () => {
    it.each([
      ['C:\\work\\proj\\src\\x.ts', 'C:/work/proj', 'src/x.ts'],
      ['c:/WORK/proj/src/x.ts', 'C:\\work\\proj\\', 'src/x.ts'],
      ['./src/x.ts', 'C:/work/proj', 'src/x.ts'],
      ['src/x.ts', 'C:/work/proj', 'src/x.ts'],
      ['C:/work/project2/x.ts', 'C:/work/proj', null],
      ['/home/u/x.ts', '/srv/repo', null],
    ])('%s from %s → %s', (target, root, glob) => {
      expect(grantGlob(target, root)).toBe(glob);
    });

    it('сверяет по форме на диске: корень короткими именами 8.3, цель — длинными', () => {
      const disk = (p: string) => p.replace(/RUSYAN~1/i, 'rusyander');
      expect(
        grantGlob(
          'C:\\Users\\rusyander\\AppData\\Local\\Temp\\repo-1\\guarded\\a1.txt',
          'C:\\Users\\RUSYAN~1\\AppData\\Local\\Temp\\repo-1',
          disk,
        ),
      ).toBe('guarded/a1.txt');
      expect(grantGlob('C:/Users/rusyander/other/a.txt', 'C:/Users/RUSYAN~1/repo', disk)).toBe(
        null,
      );
    });
  });

  describe('onDiskPath', () => {
    it('несуществующий хвост дописывается к ближайшему существующему предку в форме тома', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ondisk-'));
      try {
        expect(onDiskPath(join(dir, 'guarded', 'a1.txt'))).toBe(
          join(realpathSync.native(dir), 'guarded', 'a1.txt'),
        );
        expect(onDiskPath(dir)).toBe(realpathSync.native(dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
