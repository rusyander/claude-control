import type { Dictionary } from '../../shared/config/i18n';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from './queue.types';

/** Свёрнутый ответ одной строкой: что спросили и что выбрано. */
export function answerSummary(t: Dictionary, ask: InboxAsk, answer: AskAnswer): string {
  if (answer.kind === 'permission') {
    return `${t.home.answered[answer.behavior]} · ${'toolName' in ask ? ask.toolName : ''}`;
  }
  if (answer.kind === 'branchGate') return t.home.answered[answer.choice];
  const title = ask.kind === 'question' ? ask.question.header || ask.question.question : '';
  return title ? `${title}: ${answer.labels.join(', ')}` : answer.labels.join(', ');
}
