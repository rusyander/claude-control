import { resumeActive } from './agent-runs.commands';

/** Как часто спрашивать сервер о чужих прогонах. Ответ — из памяти, не с диска. */
export const ADOPT_INTERVAL_MS = 5000;

/**
 * Такт опроса скрытой вкладки.
 *
 * Скрытая вкладка раньше не спрашивала вовсе, и человек, сидящий в другой
 * вкладке браузера, не узнавал ни о конце хода, ни о вопросе, ни о падении,
 * пока не вернётся (живой прогон 24.09, находка 77). Реже видимой — ей нечего
 * рисовать, — но заметно чаще минуты: законченный прогон сервер называет в
 * `/chat/active` ещё минуту (grace), и только в это окно вкладка успевает
 * дотянуть его хвост и узнать, чем кончился ход.
 */
export const HIDDEN_POLL_MS = 15_000;

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Подхват прогонов, что идут на сервере, но не заводились здесь: первый вопрос
 * сразу, дальше по такту. Возвращает остановку опроса.
 *
 * Такт один на обе видимости, а скрытая вкладка пропускает лишние: так
 * переключение туда-обратно не пересоздаёт таймер и не сбивает счёт.
 */
export function startActivePoll(): () => void {
  let lastAt = Date.now();
  void resumeActive();
  const timer = setInterval(() => {
    const now = Date.now();
    if (isHidden() && now - lastAt < HIDDEN_POLL_MS) return;
    lastAt = now;
    void resumeActive();
  }, ADOPT_INTERVAL_MS);
  return () => clearInterval(timer);
}
