import { expect } from 'vitest';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type {
  SessionStreamEvent,
  SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { randomUUID7 } from '../../../core-ask/core-ask.ts';
import type { CoreChatPort } from '../../../chat/core-run/core-run.types.ts';

/**
 * Управляемое ядро для прогона агента тестов (этап 10, F6): порт отвечает как ядро — оценка,
 * команды, вид задачи, вид сеанса страницами, журнал задачи. Подменена только граница процесса
 * ядра (HTTP-порт `CoreChatPort`); `TestsCoreRun` и реестр прогонов идут своим настоящим путём.
 */

export type FakeEv = Omit<SessionStreamEvent, 'offset'>;

export interface FakeCoreOptions {
  estimate?: Awaited<ReturnType<CoreChatPort['estimate']>>;
  reject?: Partial<Record<string, CommandOutcome>>;
  turn?: FakeEv[];
  /** Первый сеанс кончается без конца хода — ход пишет второй сеанс шага. */
  restart?: boolean;
  /** Строки журнала задачи; шаг прогона передаётся, чтобы вопрос лёг на него. */
  journal?: (stepId: string) => JournalLine[];
  /** Шаг закрыт, сеанса нет. */
  stepEnds?: boolean;
  /** Ход не кончается, пока прогон не остановят. */
  hold?: boolean;
  /** Что «агент» делает в рабочем дереве на запуске (до записи хода). */
  onLaunch?: () => void;
}

export interface FakeCorePort {
  port: CoreChatPort;
  taskId: string;
  stepId: string;
  sessions: string[];
  calls: Array<{ kind: string; fields: Record<string, unknown> }>;
  estimates: EstimateFields[];
  /** Значения окружения задачи, пришедшие телом оценки (по одной записи на оценку). */
  envs: Array<Record<string, string> | undefined>;
}

export const FAKE_TURN: FakeEv[] = [
  { kind: 'assistant-text', data: { text: 'Гоняю кейсы.' } },
  { kind: 'thinking', data: { text: 'hidden' } },
  {
    kind: 'tool-call',
    data: { toolUseId: 'tu1', name: 'Edit', input: { file_path: '.agent/tests/a.json' } },
  },
  { kind: 'tool-result', data: { toolUseId: 'tu1', isError: false } },
  { kind: 'usage', data: { messageId: 'm1', input: 10, output: 5, cacheRead: 100, cacheWrite: 7 } },
  { kind: 'turn-end', data: { isError: false, numTurns: 1 } },
];

export function fakeCorePort(opts: FakeCoreOptions = {}): FakeCorePort {
  const taskId = randomUUID7();
  const stepId = randomUUID7();
  const sessions = [randomUUID7(), randomUUID7()];
  const calls: FakeCorePort['calls'] = [];
  const estimates: EstimateFields[] = [];
  const envs: FakeCorePort['envs'] = [];
  const journal = opts.journal?.(stepId) ?? [];
  let launched = false;
  let live = 0;
  let offset = 0;
  const streams = new Map<string, SessionStreamEvent[]>();
  const write = (sid: string, events: FakeEv[]): void => {
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
              state: opts.stepEnds ? 'failed' : 'running',
              startedSeq: 1,
              outcome: opts.stepEnds ? 'failed' : null,
              reason: opts.stepEnds ? 'adapter refused' : null,
            },
          ]
        : [],
      sessions: sessions
        .slice(0, live)
        .map((sessionId, i) => ({ sessionId, stepId, startedSeq: 2 + i })),
      asks: journal.map((l) => ({
        askId: (l.data as { askId: string }).askId,
        state: calls.some(
          (c) => c.kind === 'answer' && c.fields.askId === (l.data as { askId: string }).askId,
        )
          ? 'answered'
          : 'open',
      })),
    }) as unknown as TaskView;
  const port: CoreChatPort = {
    async estimate(fields, env) {
      estimates.push(fields);
      envs.push(env);
      return opts.estimate ?? { ok: true, taskId };
    },
    async attach() {
      return { ok: false, code: 'not-in-fake', message: 'agent runs carry no attachments' };
    },
    async command(id, kind, fields) {
      expect(id).toBe(taskId);
      calls.push({ kind, fields: fields as Record<string, unknown> });
      const refused = opts.reject?.[kind];
      if (refused) return refused;
      if (kind === 'launch') {
        launched = true;
        opts.onLaunch?.();
        if (!opts.stepEnds) {
          live = 1;
          if (opts.restart) {
            write(sessions[0]!, [{ kind: 'assistant-text', data: { text: 'half ' } }]);
            live = 2;
          }
          if (!opts.hold) write(sessions[opts.restart ? 1 : 0]!, opts.turn ?? []);
        }
      }
      return { cmdId: 'c', status: 'applied', seq: calls.length } as CommandOutcome;
    },
    async view(id) {
      return id === taskId ? view() : null;
    },
    async page(_t, sid, from) {
      const events = (streams.get(sid) ?? []).filter((e) => e.offset >= from);
      return { taskId, sessionId: sid, adapter: 'claude', events, next: offset + 1, done: false };
    },
    async *follow(_t, sid, from, signal) {
      const events = (streams.get(sid) ?? []).filter((e) => e.offset >= from);
      const ended = Boolean(opts.restart && sid === sessions[0]);
      const page: SessionStreamPage = {
        taskId,
        sessionId: sid,
        adapter: 'claude',
        events,
        next: offset,
        done: ended,
      };
      yield page;
      if (ended) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    async *taskEvents(_t, signal) {
      for (const line of journal) yield line;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
  };
  return { port, taskId, stepId, sessions, calls, estimates, envs };
}

/** Строка журнала «ядро спросило право» на шаге прогона. */
export function permitAsked(stepId: string, askId: string, question: string): JournalLine {
  return {
    seq: 9,
    at: 't',
    taskId: 't',
    stepId,
    kind: 'human.asked',
    actor: 'core',
    data: { askId, source: 'permit', question },
  } as unknown as JournalLine;
}

export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}
