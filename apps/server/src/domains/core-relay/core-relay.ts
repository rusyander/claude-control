import type { RelayPending, RelayState } from '@agentdeck/contracts/core/relay';
import { askWaits } from '@agentdeck/contracts/core/waiting';
import type { CoreRelay, CoreRelayDeps, CoreSseEvent, RelayTask } from './core-relay.types.ts';
import { readRelayState, writeRelayState } from './state.ts';

/**
 * Пересылка вопросов ядра людям (этап 10, Q9): ядро каналов не знает, секреты каналов — у панели.
 * Каждый круг панель берёт список задач ядра, на каждую живую держит поток событий с места
 * курсора, и строка `human.asked` открытого вопроса становится уведомлением (push, Telegram) со
 * ссылкой на задачу. Ответить канал не может — только панель или подпись телефона.
 *
 * «Ровно раз через перезапуск панели»: курсор (`id:` последней прочитанной строки) и список
 * отправленных вопросов лежат в `<дом панели>/core-relay.json` и пишутся сразу после отправки.
 * Новая панель читает поток с курсора — строку вопроса второй раз не получает; поток с начала
 * (курсора нет) проходит отправленные мимо по списку, а давно отвеченные — по виду задачи.
 * Окно «отправлено, но не записано» (панель убили между двумя действиями) даёт повтор — второе
 * сообщение лучше потерянного вопроса.
 *
 * Сообщить некуда (ни push, ни Telegram не настроены) или все каналы упали — вопрос НЕ считается
 * сообщённым: он ждёт в `pending` того же файла (курсор уже за его строкой) и уходит первым кругом,
 * когда канал появился; ответили раньше — тихо уходит из ожидания.
 */

const DEFAULT_INTERVAL_MS = 3_000;
/** Курсор без отправки пишется не чаще: поток задачи — сотни строк, файл — один. */
const CURSOR_FLUSH_MS = 1_000;
/** Повтор вопроса после упавшей попытки (канал настроен, но не принял). */
const RETRY_MS = 30_000;
const TITLE_MAX = 500;
const FALLBACK_TITLE = 'Задача ядра';

interface AskLine {
  askId: string;
  question: string;
  /** Блокирует ли вопрос (`askWaits`); у записи `pending` до этапа 12 поля нет — блокирует. */
  waits?: boolean;
}

/** Строка журнала из `data:` — вопрос человеку или `null` (чужой вид, кривая строка). */
function askOf(event: CoreSseEvent): AskLine | null {
  if (event.event !== 'human.asked') return null;
  try {
    const line = JSON.parse(event.data) as { kind?: unknown; data?: Record<string, unknown> };
    const askId = line.data?.askId;
    const question = line.data?.question;
    if (line.kind !== 'human.asked' || typeof askId !== 'string') return null;
    const defaultAction = line.data?.defaultAction;
    return {
      askId,
      question: typeof question === 'string' ? question : '',
      // Та же функция, что у доски и телефона (P153): блокирует только вопрос без умолчания.
      waits: askWaits({
        defaultAction:
          typeof defaultAction === 'string' || defaultAction === null ? defaultAction : undefined,
      }),
    };
  } catch {
    return null;
  }
}

export function createCoreRelay(deps: CoreRelayDeps): CoreRelay {
  const state: RelayState = readRelayState(deps.statePath, deps.log);
  const delivered = new Set(state.delivered);
  const pending = new Map<string, RelayPending>(state.pending.map((item) => [item.askId, item]));
  /** После упавшей попытки — не раньше этого времени (в памяти: новая панель пробует сразу). */
  const retryAt = new Map<string, number>();
  const sending = new Set<string>();
  const streams = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | undefined;
  let dirtyAt = 0;
  let stopped = false;
  let down: string | undefined;

  const persist = (): void => {
    dirtyAt = 0;
    try {
      writeRelayState(deps.statePath, {
        cursors: state.cursors,
        delivered: [...delivered],
        pending: [...pending.values()],
      });
    } catch (error) {
      deps.log(`core-relay: state not written: ${error instanceof Error ? error.message : error}`);
    }
  };

  const remember = (taskId: string, id: string | null): void => {
    if (id === null) return;
    state.cursors[taskId] = id;
    const now = Date.now();
    if (dirtyAt === 0) dirtyAt = now;
    if (now - dirtyAt >= CURSOR_FLUSH_MS) persist();
  };

  const ready = (waits: boolean): boolean => deps.ready?.(waits) ?? true;
  const waitsOf = (ask: AskLine): boolean => ask.waits ?? true;

  /**
   * Одна попытка сообщить. `skipped` — каналов нет, не пробовали (ждать, пока появятся);
   * `failed` — пробовали, ни один не принял (повтор не раньше `RETRY_MS`, чтобы упавший Telegram
   * не получал запрос каждые три секунды).
   */
  const attempt = async (task: RelayTask, ask: AskLine): Promise<'sent' | 'skipped' | 'failed'> => {
    if (!ready(waitsOf(ask))) return 'skipped';
    sending.add(ask.askId);
    try {
      const ok = await deps.deliver({
        notice: {
          taskId: task.taskId,
          askId: ask.askId,
          kind: 'ask',
          title: (task.title?.trim() || FALLBACK_TITLE).slice(0, TITLE_MAX),
          deepLink: deps.link(task.taskId, ask.askId),
        },
        question: ask.question,
        waits: waitsOf(ask),
      });
      return ok ? 'sent' : 'failed';
    } catch (error) {
      deps.log(`core-relay: not delivered: ${error instanceof Error ? error.message : error}`);
      return 'failed';
    } finally {
      sending.delete(ask.askId);
    }
  };

  /** Итог попытки в состояние: сообщено — в `delivered`, иначе — ждёт в `pending`. */
  const settleAsk = (taskId: string, ask: AskLine, result: 'sent' | 'skipped' | 'failed'): void => {
    if (result === 'sent') {
      pending.delete(ask.askId);
      retryAt.delete(ask.askId);
      delivered.add(ask.askId);
      return;
    }
    pending.set(ask.askId, {
      taskId,
      askId: ask.askId,
      question: ask.question,
      waits: waitsOf(ask),
    });
    if (result === 'failed') retryAt.set(ask.askId, Date.now() + RETRY_MS);
  };

  const relayAsk = async (task: RelayTask, ask: AskLine, id: string | null): Promise<void> => {
    // Уже сообщён, уже ждёт канала или уходит прямо сейчас — строка вопроса второй раз ничего не
    // шлёт (поток с начала после потери курсора, круг повтора параллельно потоку).
    if (delivered.has(ask.askId) || pending.has(ask.askId) || sending.has(ask.askId)) {
      remember(task.taskId, id);
      return;
    }
    const askState = await deps.core.askState(task.taskId, ask.askId);
    // Отвечен, истёк, отозван — сообщать не о чем (поток с начала проходит старые вопросы).
    if (askState !== null && askState !== 'open') {
      remember(task.taskId, id);
      return;
    }
    settleAsk(task.taskId, ask, await attempt(task, ask));
    if (id !== null) state.cursors[task.taskId] = id;
    persist();
  };

  /**
   * Ждущие канала вопросы: курсор уже за их строками, поэтому повтор — отсюда, каждым кругом, как
   * только канал есть. Задачи нет в списке или вопрос уже не открыт — сообщать не о чем.
   */
  const retryPending = async (tasks: RelayTask[]): Promise<void> => {
    if (pending.size === 0) return;
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    let changed = false;
    for (const item of [...pending.values()]) {
      if (stopped) break;
      const task = byId.get(item.taskId);
      if (!task) {
        pending.delete(item.askId);
        retryAt.delete(item.askId);
        changed = true;
        continue;
      }
      // Канал смотрится по вопросу: для неблокирующего push не канал, а Telegram — канал.
      if (!ready(waitsOf(item))) continue;
      if ((retryAt.get(item.askId) ?? 0) > Date.now() || sending.has(item.askId)) continue;
      let askState: string | null;
      try {
        askState = await deps.core.askState(item.taskId, item.askId);
      } catch {
        continue;
      }
      if (askState !== null && askState !== 'open') {
        pending.delete(item.askId);
        retryAt.delete(item.askId);
        changed = true;
        continue;
      }
      const result = await attempt(task, item);
      settleAsk(item.taskId, item, result);
      if (result === 'sent') changed = true;
    }
    if (changed) persist();
  };

  const follow = async (task: RelayTask, signal: AbortSignal): Promise<void> => {
    try {
      for await (const event of deps.core.events(task.taskId, state.cursors[task.taskId], signal)) {
        if (deps.onLine) {
          try {
            await deps.onLine(task, event);
          } catch (error) {
            deps.log(
              `core-relay: onLine ${task.taskId}: ${error instanceof Error ? error.message : error}`,
            );
          }
        }
        const ask = askOf(event);
        if (ask) await relayAsk(task, ask, event.id);
        else remember(task.taskId, event.id);
      }
    } catch (error) {
      if (!signal.aborted) {
        deps.log(
          `core-relay: stream ${task.taskId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    } finally {
      if (dirtyAt !== 0) persist();
      streams.delete(task.taskId);
    }
  };

  const round = async (): Promise<void> => {
    let tasks: RelayTask[];
    try {
      tasks = await deps.core.tasks();
    } catch (error) {
      // Ядра нет или оно не сверилось — потоки и курсоры живут до следующего круга. В журнал —
      // только смена причины: ядро без запуска иначе писало бы строку каждые три секунды.
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== down) deps.log(`core-relay: core unavailable: ${reason}`);
      down = reason;
      return;
    }
    down = undefined;
    const live = new Set(tasks.filter((task) => task.live).map((task) => task.taskId));
    for (const [taskId, stream] of streams) if (!live.has(taskId)) stream.abort.abort();
    // Курсор задачи, которой в списке больше нет, не понадобится.
    const known = new Set(tasks.map((task) => task.taskId));
    let pruned = false;
    for (const taskId of Object.keys(state.cursors)) {
      if (known.has(taskId)) continue;
      delete state.cursors[taskId];
      pruned = true;
    }
    if (pruned) persist();
    for (const task of tasks) {
      if (stopped || !task.live || streams.has(task.taskId)) continue;
      const abort = new AbortController();
      const entry = { abort, done: Promise.resolve() };
      streams.set(task.taskId, entry);
      entry.done = follow(task, abort.signal);
    }
    await retryPending(tasks);
  };

  const tick = (): Promise<void> => {
    ticking ??= round().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };

  return {
    tick,
    start() {
      if (timer) return;
      stopped = false;
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      // Синхронная часть — до первого `await`: панель на выходе (`shutdown` → `process.exit`)
      // асинхронного хвоста не ждёт, а таймер, потоки и недописанный курсор должны уйти и там.
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const open = [...streams.values()];
      for (const stream of open) stream.abort.abort();
      if (dirtyAt !== 0) persist();
      await ticking;
      // Круг, шедший во время остановки, новых потоков не открыл (`stopped`), но дождаться всех.
      await Promise.all([...open, ...streams.values()].map((stream) => stream.done));
    },
  };
}
