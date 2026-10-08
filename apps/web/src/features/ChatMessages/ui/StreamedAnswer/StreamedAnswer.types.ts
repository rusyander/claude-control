import type { CascadeCeiling } from '@agentdeck/contracts/model-cascade';
import type { StreamState } from '@entities/Chat';

export interface StreamedAnswerProps {
  /** Ответ, который набирается прямо сейчас. */
  stream: StreamState;
  /** Потолок разговора: по нему карточка предложения показывает модель группы. */
  splitCeiling?: CascadeCeiling;
  /** Единицы расхода из настроек: объём в токенах или деньги. */
  costUnit?: 'tokens' | 'money';
  /** Глубина продумывания текущего прогона — идёт в разбивку расхода. */
  effort?: string;
}
