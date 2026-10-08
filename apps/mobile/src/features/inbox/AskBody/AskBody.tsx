import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from '../queue.types';
import { ToolAsk } from './ToolAsk/ToolAsk';
import { QuestionAsk } from './QuestionAsk/QuestionAsk';

/**
 * Текущий вопрос карточки — один за раз. Ответ здесь только ВЫБИРАЕТСЯ: уходит
 * он кнопкой «Отправить» карточки, вместе с остальными ответами этого чата.
 */
export function AskBody({
  ask,
  previous,
  disabled,
  onAnswer,
}: {
  ask: InboxAsk;
  /** Уже выбранное — когда к вопросу вернулись кнопкой «Изменить». */
  previous?: AskAnswer;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  if (ask.kind === 'question') {
    return (
      <QuestionAsk
        // Новый вопрос — чистый выбор: отмеченное в прошлом не переезжает.
        key={ask.key}
        ask={ask}
        previous={previous?.kind === 'question' ? previous.labels : []}
        disabled={disabled}
        onAnswer={(labels) => onAnswer({ kind: 'question', labels })}
      />
    );
  }
  return <ToolAsk key={ask.key} ask={ask} disabled={disabled} onAnswer={onAnswer} />;
}
