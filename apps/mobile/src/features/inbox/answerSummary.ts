import type { Dictionary } from '../../shared/config/i18n';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from './queue.types';

/** Свёрнутый ответ одной строкой: что спросили и что выбрано. */
export function answerSummary(t: Dictionary, ask: InboxAsk, answer: AskAnswer): string {
  if (answer.kind === 'permission') {
    // Вопрос ядра — подписью значка, а не служебным именем «инструмента» карточки.
    const what = ask.kind === 'permission' && ask.core ? t.coreTask.permitBadge : '';
    return `${t.home.answered[answer.behavior]} · ${what || ('toolName' in ask ? ask.toolName : '')}`;
  }
  const title = ask.kind === 'question' ? ask.question.header || ask.question.question : '';
  return title ? `${title}: ${answer.labels.join(', ')}` : answer.labels.join(', ');
}
