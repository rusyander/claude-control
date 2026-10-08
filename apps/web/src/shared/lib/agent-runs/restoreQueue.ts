import { resumeActive } from './resumeActive';
import { drainQueue } from './agent-runs.lifecycle';
import { loadQueue } from './loadQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { findKey } from './findKey';

/**
 * Вернуть в стор очередь, сохранённую до перезагрузки страницы.
 *
 * Зовётся при открытии разговора. Прогон при этом может и идти (тогда очередь
 * просто снова видна и уйдёт по концу хода), а может и не существовать вовсе —
 * страницу перезагрузили уже после того, как агент договорил. Во втором случае
 * досылаем сразу: очередь и значит «скажи ему это, как освободится», и он
 * свободен. Память вкладки всегда свежее хранилища, поэтому непустую очередь не
 * трогаем.
 *
 * `sessionId` — id, которым продолжается разговор (у нового чата его ещё нет).
 */
export async function restoreQueue(id: string, sessionId?: string): Promise<void> {
  const items = loadQueue(sessionId, id);
  if (items.length === 0) return;

  // Прогон этого разговора может идти на сервере, а вкладка (только что
  // открытая) о нём ещё не знать. Сперва подхват, потом очередь: заведи мы
  // здесь свою запись прогона раньше, `resumeActive` счёл бы разговор уже
  // известным и живой прогон остался бы невидимым — без вывода, без точки и
  // без «Остановить».
  let key = findKey(id) ?? findKey(sessionId);
  if (!key) {
    await resumeActive();
    key = findKey(id) ?? findKey(sessionId);
  }
  // Подхваченный прогон свою очередь уже восстановил — она уйдёт по концу хода.
  if (key && (runs.get(key)?.queued.length ?? 0) > 0) return;

  const target = key ?? id;
  const run = runs.get(target);
  setRun(target, {
    id: run?.id || target,
    sessionId: run?.sessionId ?? sessionId,
    queued: items,
  });
  emit();
  // Агент свободен — значит момент, ради которого очередь и заводилась, уже
  // наступил: досылаем, как дослали бы без перезагрузки страницы.
  if (runs.get(target)?.status !== 'running') drainQueue(target);
}
