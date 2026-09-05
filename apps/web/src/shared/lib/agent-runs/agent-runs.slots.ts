import { MAX_STREAMS } from './agent-runs.constants';
import { runStream } from './agent-runs.lifecycle';
import {
  callbacks,
  controllers,
  emit,
  findKey,
  lastSeqs,
  runs,
  sending,
  setRun,
} from './agent-runs.state';
import type { AgentRun } from './agent-runs.types';

/**
 * Бюджет потоков вкладки.
 *
 * Браузер по HTTP/1.1 даёт шесть соединений на источник — на все вкладки
 * разом. Поток на каждый идущий прогон плюс лента событий съедали их все, и
 * отправка в седьмой разговор вставала в очередь браузера без ошибки и без
 * срока — ровно так, как выглядит «панель зависла». Поэтому потоков не больше
 * `MAX_STREAMS`, а кто их держит, решает приоритет: отправка, открытый
 * разговор, прогон, ждущий человека, ветви открытого, дотягиваемый хвост,
 * остальные — по старшинству. Прогон без потока «припаркован»: сервер ведёт
 * его как прежде, вкладка знает о нём из опроса `/chat/active`, а поток
 * получает, как только освободится место. Скрытая вкладка не держит ни одного:
 * её потоки нужны никому, а соединения — соседней вкладке.
 */

/** Разговоры, на которые смотрят вместе с открытым, — его ветви-дети. */
let watched = new Set<string>();

/** Страница сообщает, чьи прогоны сейчас важны помимо открытого. */
export function setWatched(ids: string[]): void {
  const next = new Set(ids);
  if (next.size === watched.size && [...next].every((id) => watched.has(id))) return;
  watched = next;
  rebalance();
}

/** Сколько потоков вкладке можно держать сейчас. Скрытой — ни одного. */
export function budget(): number {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 0;
  return MAX_STREAMS;
}

function isAwaitingHuman(run: AgentRun): boolean {
  return (
    run.permissions.length > 0 ||
    run.askedQuestion ||
    run.tools.some((tool) => tool.name === 'AskUserQuestion')
  );
}

function matches(id: string | undefined, key: string, run: AgentRun): boolean {
  return Boolean(id) && (id === key || id === run.sessionId || findKey(id) === key);
}

/** Место прогона в очереди за потоком: меньше — важнее. */
export function priority(key: string, run: AgentRun): number {
  if (sending.has(key)) return 0;
  if (matches(callbacks.activeId, key, run)) return 1;
  if (isAwaitingHuman(run)) return 2;
  if ([...watched].some((id) => matches(id, key, run))) return 3;
  // Хвост законченного: догнать цену и вопрос — секунды, место освободится сразу.
  if (run.tailOnly) return 4;
  return 5;
}

function rank(key: string): [number, number] {
  const run = runs.get(key);
  return run ? [priority(key, run), run.startedAt ?? 0] : [Infinity, 0];
}

function byRank(a: string, b: string): number {
  const [pa, ta] = rank(a);
  const [pb, tb] = rank(b);
  return pa - pb || ta - tb;
}

function parkedKeys(): string[] {
  const keys: string[] = [];
  for (const [key, run] of runs) if (run.parked && !controllers.has(key)) keys.push(key);
  return keys;
}

/** Подключить припаркованный прогон: с того места, где его отпустили. */
export function attachRun(key: string): void {
  const run = runs.get(key);
  if (!run || controllers.has(key)) return;
  const controller = new AbortController();
  controllers.set(key, controller);
  if (!lastSeqs.has(key)) lastSeqs.set(key, 0);
  setRun(key, { parked: undefined, lastEventAt: Date.now() });
  emit();
  void runStream(key, { chatId: key, prompt: '' }, controller, 'attach');
}

/**
 * Отпустить поток прогона, не завершая сам прогон.
 *
 * Контроллер снимается СРАЗУ: дочитывающий поток по нему поймёт, что он больше
 * не ведёт разговор, и уйдёт молча — без `finalize`, без досылки очереди (см.
 * `runStream`). Последний `seq` остаётся: подключение продолжит с него.
 */
export function parkRun(key: string): void {
  const controller = controllers.get(key);
  if (!controller || sending.has(key)) return;
  controllers.delete(key);
  setRun(key, { parked: true });
  emit();
  controller.abort(new DOMException('Поток отпущен: лимит соединений', 'AbortError'));
}

/**
 * Привести потоки к бюджету: лишние — отпустить, свободные места — раздать
 * припаркованным по приоритету, и поменять местами, если ждущий важнее
 * держащего. Отправку не трогает никогда: сообщение обязано уйти.
 */
export function rebalance(): void {
  const limit = budget();
  for (let guard = 0; guard < 32; guard += 1) {
    const streamed = [...controllers.keys()].filter((key) => !sending.has(key)).sort(byRank);
    const parked = parkedKeys().sort(byRank);
    const worst = streamed[streamed.length - 1];
    const best = parked[0];

    if (controllers.size > limit && worst) {
      parkRun(worst);
      continue;
    }
    if (!best) return;
    if (controllers.size < limit) {
      attachRun(best);
      continue;
    }
    if (worst && rank(best)[0] < rank(worst)[0]) {
      parkRun(worst);
      attachRun(best);
      continue;
    }
    return;
  }
}

let watching = false;

/** Следить за видимостью вкладки: скрытая отдаёт потоки, вернувшаяся забирает. */
export function ensureSlotsWatch(): void {
  callbacks.rebalance = rebalance;
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('visibilitychange', rebalance);
}
