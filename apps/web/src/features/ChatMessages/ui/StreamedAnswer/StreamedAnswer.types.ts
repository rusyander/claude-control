import type { StreamState } from '@entities/Chat';

export interface StreamedAnswerProps {
  /** Ответ, который набирается прямо сейчас. */
  stream: StreamState;
  /** Единицы расхода из настроек: объём в токенах или деньги. */
  costUnit?: 'tokens' | 'money';
  /** Глубина продумывания текущего прогона — идёт в разбивку расхода. */
  effort?: string;
}
