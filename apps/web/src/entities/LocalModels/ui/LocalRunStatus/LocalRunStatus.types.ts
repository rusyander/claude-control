export interface LocalRunStatusProps {
  /** Ход ждёт решения человека по правам: запрос к модели в это время не идёт. */
  waitingPermission: boolean;
  /** Начало хода, мс: отказ и запросы раньше него — прошлого хода. */
  since?: number;
  className?: string;
}
