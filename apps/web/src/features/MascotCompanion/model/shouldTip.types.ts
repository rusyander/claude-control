export interface TipGate {
  now: number;
  /** Когда компаньон появился на экране. */
  mountedAt: number;
  /** Когда Дека последний раз говорил сам (любая реплика). */
  lastSpokeAt?: number;
  /** Последний ввод человека: клавиша, клик, колесо. */
  lastInputAt: number;
  chatty: boolean;
  /** Вкладка скрыта. */
  hidden: boolean;
  asleep: boolean;
  panelOpen: boolean;
  /** Реплика уже на экране. */
  speaking: boolean;
  /** Ждущих ответа и упавших вместе. */
  attention: number;
}
