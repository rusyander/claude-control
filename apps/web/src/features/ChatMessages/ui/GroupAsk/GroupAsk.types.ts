import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ChildQuestion } from '../ChildQuestion.types';

export interface GroupAskProps {
  /** Вопросы последнего звена группы — того, чей ключ у карточки. */
  questions: ChildQuestion[];
  /** Стадия этого звена: человеку видно, на чём группа спросила. */
  stage?: CascadeStage;
  onAnswer: (chatId: string, answer: string) => void;
}
