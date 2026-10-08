import type { InboxChat, InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { CardState, Submission } from './queue.types';
import { composeAnswer } from './composeAnswer';

/**
 * Что отправить по нажатию «Отправить». Решения по правам — первыми: за ними
 * стоит живой процесс, который ждёт. Ответ на вопросы — последним и одним
 * сообщением: если агент ещё работает, оно встанет в очередь и уйдёт по концу
 * хода, как в панели.
 */
export function planSubmissions(
  chat: Pick<InboxChat, 'runKey'>,
  asks: readonly InboxAsk[],
  state: CardState,
): Submission[] {
  const out: Submission[] = [];
  const questions: Extract<InboxAsk, { kind: 'question' }>[] = [];
  for (const ask of asks) {
    const answer = state.answers[ask.key];
    if (!answer) continue;
    if (ask.kind === 'question') {
      questions.push(ask);
      continue;
    }
    if (!chat.runKey) continue;
    if (ask.kind === 'permission' && answer.kind === 'permission') {
      out.push({
        kind: 'permission',
        runKey: chat.runKey,
        toolUseId: ask.toolUseId,
        behavior: answer.behavior,
        keys: [ask.key],
      });
    }
    if (ask.kind === 'branchGate' && answer.kind === 'branchGate') {
      out.push({
        kind: 'branchGate',
        runKey: chat.runKey,
        toolUseId: ask.toolUseId,
        choice: answer.choice,
        keys: [ask.key],
      });
    }
  }
  const text = composeAnswer(questions, state.answers);
  if (text) out.push({ kind: 'message', text, keys: questions.map((ask) => ask.key) });
  return out;
}
