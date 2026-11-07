import type {
  SessionStreamEvent,
  SessionStreamPage,
} from '@agentdeck/contracts/core/session-stream';
import type { CoreChatPort } from '../core-run.types.ts';
import { stubCorePort } from './stub-core-port.ts';

/**
 * Ядро на границе для маршрутов разговора чужого CLI: `stubCorePort`, у которого вид сеанса отдаёт
 * каждый посланный задаче ход (запрос оценки, затем `message-to-step`) с ответом `answer` — как
 * вид сеанса ядра. Поток сеанса после конца хода висит до обрыва, как живой.
 */
export function coreWithTurns(options: {
  sessionId: string;
  answer: string;
  /** Стена отправки первого хода; следующий — на миллисекунду позже. */
  turnAt: number;
  adapter?: string;
}): ReturnType<typeof stubCorePort> {
  const stub = stubCorePort({ sessionId: options.sessionId });
  const turnsOf = (taskId: string): string[] => {
    const n = Number(taskId.replace('stub-task-', '')) - 1;
    const first = stub.estimates[n]?.request;
    const later = stub.calls
      .filter((c) => c.taskId === taskId && c.kind === 'message-to-step')
      .map((c) => String(c.fields.text ?? ''));
    return first === undefined ? later : [first, ...later];
  };
  const eventsOf = (taskId: string): SessionStreamEvent[] =>
    turnsOf(taskId).flatMap(
      (text, i) =>
        [
          { offset: i * 30, kind: 'user-text', data: { text, sentAt: options.turnAt + i } },
          { offset: i * 30 + 10, kind: 'assistant-text', data: { text: options.answer } },
          { offset: i * 30 + 20, kind: 'turn-end', data: { isError: false, numTurns: 1 } },
        ] as SessionStreamEvent[],
    );
  const pageOf = (taskId: string, sessionId: string, from: number): SessionStreamPage => {
    const events = eventsOf(taskId).filter((e) => e.offset >= from);
    return {
      taskId,
      sessionId,
      adapter: options.adapter ?? 'qwen',
      events,
      next: (eventsOf(taskId).at(-1)?.offset ?? -1) + 1,
      done: false,
    } as SessionStreamPage;
  };
  const port: CoreChatPort = {
    ...stub.port,
    page: async (taskId, sessionId, from) => pageOf(taskId, sessionId, from ?? 0),
    async *follow(taskId, sessionId, from, signal) {
      yield pageOf(taskId, sessionId, from ?? 0);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
  };
  return { ...stub, port };
}
