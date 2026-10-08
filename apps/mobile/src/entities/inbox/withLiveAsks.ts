import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import type { AgentRun } from '../../shared/lib/runs/types';
import { liveQuestionAsks } from './liveQuestionAsks';
import { runNamed } from '../../shared/lib/runs/store';

/**
 * Сводка с вопросами живых ходов. Чат, где поток знает вопрос, которого нет в
 * ответе сервера, получает его строкой и статус «ждёт вас»; остальные чаты —
 * те же объекты, что пришли.
 */
export function withLiveAsks(chats: readonly InboxChat[], runs: readonly AgentRun[]): InboxChat[] {
  return chats.map((chat) => {
    const run = runNamed(runs, chat.runKey, chat.sessionId, chat.id);
    if (!run) return chat;
    const known = new Set(chat.asks.map((ask) => ask.key));
    const extra = liveQuestionAsks(run).filter((ask) => !known.has(ask.key));
    if (extra.length === 0) return chat;
    const asks = [...chat.asks, ...extra].sort(
      (a, b) => a.askedAt.localeCompare(b.askedAt) || a.key.localeCompare(b.key),
    );
    const newest = asks.reduce((at, ask) => (ask.askedAt > at ? ask.askedAt : at), chat.updatedAt);
    return { ...chat, asks, status: 'waiting', updatedAt: newest };
  });
}
