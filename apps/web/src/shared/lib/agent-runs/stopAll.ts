import { controllers } from './agent-runs.state';
import { autoRetryTimers } from './agent-runs.retry';
import { stopRun } from './stopRun';

/**
 * Остановить все идущие прогоны разом — кнопка «Остановить всех» в пульте.
 *
 * Идём ровно тем же путём, что и одиночный `stop`. Перебирать одни
 * `controllers` мало: прогон, ждущий отложенного авто-рестарта, контроллера
 * уже не имеет (его убрали в `finally`), и такой прогон «Остановить всех»
 * не задевало вовсе — через пару секунд таймер поднимал агента снова, уже
 * после явной остановки. Поэтому берём и владельцев таймеров, и помечаем всех
 * как остановленных человеком.
 */
export function stopAll(): void {
  for (const key of new Set([...controllers.keys(), ...autoRetryTimers.keys()])) {
    stopRun(key);
  }
}
