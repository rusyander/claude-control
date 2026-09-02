import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { MAX_AUTO_RETRIES, MAX_RECONNECT } from './agent-runs.constants';
import {
  autoRetries,
  autoRetryTimers,
  pickRetryPrompt,
  shouldAutoRetry,
  stoppedByUser,
} from './agent-runs.retry';
import { loadSpend } from './agent-runs.spend';
import { sleep } from './agent-runs.sse';
import {
  callbacks,
  controllers,
  emit,
  getRun,
  lastSeqs,
  pendingUsage,
  runs,
  setRun,
} from './agent-runs.state';
import { ensureWatchdog, rebuildStatuses } from './agent-runs.statuses';
import { openStream } from './agent-runs.stream';
import type { AgentRun, SendOutcome, StartInput } from './agent-runs.types';
import type { RunStatus } from './status';

/**
 * Жизненный цикл прогона: запуск, ведение потока с переподключением, авто-рестарт
 * после временного сбоя, завершение и досылка очереди. Части цикла вызывают друг
 * друга (очередь → запуск → поток → завершение), поэтому живут в одном модуле.
 */

/**
 * Чем закончился ход: ошибка важнее заданного вопроса, а без того и другого
 * прогон просто затих.
 */
function finalStatus(run: AgentRun): RunStatus {
  if (run.error) return 'error';
  if (run.askedQuestion) return 'waiting';
  return 'idle';
}

export function finalize(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  const status = finalStatus(run);
  const activeId = callbacks.activeId;
  const isActive = activeId != null && (activeId === run.id || activeId === run.sessionId);

  // Фоновый прогон: текст ответа уже в истории, на экране его нет — освобождаем
  // память, но статус (цвет точки) и текст ошибки сохраняем. Завершённый прогон
  // не держит висящих запросов прав — их снимаем.
  // Вопрос человеку переживает конец хода: на него ещё не ответили. Он же
  // показывается в РОДИТЕЛЬСКОМ разговоре, а тот про чужой транскрипт ничего не
  // знает — вычисти мы здесь всё, вопрос ребёнка исчез бы у родителя ровно в тот
  // момент, когда ребёнок замолчал и ответа ждать стало некому.
  const asked = run.tools.filter((tool) => tool.name === 'AskUserQuestion');
  const finalized: AgentRun = isActive
    ? { ...run, status, permissions: [] }
    : { ...run, status, text: '', thinking: '', tools: asked, permissions: [] };
  runs.set(id, finalized);
  // Ход закончен — все вызовы уже пришли, ждать больше нечему.
  pendingUsage.delete(id);
  rebuildStatuses();
  emit();

  // Уведомляем только о фоновых проектных прогонах: активный виден и так, а
  // фоновый агент мог задать вопрос или упасть, пока ты в другом табе.
  if (!isActive && finalized.projectPath && callbacks.onBackgroundEvent) {
    callbacks.onBackgroundEvent(finalized);
  }

  // Ход закончился — самое время отдать то, что человек дописал, пока агент был
  // занят. Остановленному человеком прогону очередь не досылаем: он остановил.
  if (!stoppedByUser.has(id)) drainQueue(id);
}

/**
 * Отправить следующее сообщение из очереди — по одному: второе дождётся конца
 * хода, который сейчас начнётся. Продолжаем ту же сессию, поэтому дописанное
 * попадает в тот же контекст, а не заводит разговор заново.
 *
 * Отказ «прогон занят» на этом пути НЕ теряет сообщение. В разговоре мог успеть
 * начаться новый ход — с телефона, из соседнего окна или потому, что сервер ещё
 * не снял прошлый (терминальное событие уходит на мгновение раньше, чем прогон
 * покидает реестр, — замерено живым прогоном 2 сентября). Молча съеденное здесь
 * дописанное исчезло бы совсем: из очереди оно уже вынуто, а в ленту не попало.
 * Возвращаем его в НАЧАЛО очереди — досылка повторится по концу того хода.
 */
function drainQueue(id: string): void {
  const run = runs.get(id);
  if (!run || run.queued.length === 0) return;

  const next = run.queued[0];
  if (!next) return;
  runs.set(id, { ...run, queued: run.queued.slice(1) });
  emit();

  void startRun({
    chatId: run.id || id,
    prompt: next.prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    files: next.files,
    allowEdits: next.allowEdits,
    autoApprove: next.autoApprove,
    model: next.model,
    effort: next.effort,
  }).then((outcome) => {
    if (outcome.ok || outcome.code !== 'run_busy') return;
    const current = runs.get(id);
    if (!current) return;
    runs.set(id, { ...current, queued: [next, ...current.queued] });
    emit();
  });
}

/**
 * Вести прогон: открыть поток и, если он оборвётся без завершения, автоматически
 * переподключиться, догнав пропущенное с последнего seq. Сдаёмся после
 * `MAX_RECONNECT` попыток — тогда финализируем по тому, что успели получить, а
 * ответ подтянется из истории.
 */
export async function runStream(
  id: string,
  input: StartInput,
  controller: AbortController,
  initial: 'send' | 'attach',
  settle?: (outcome: SendOutcome) => void,
): Promise<void> {
  try {
    let outcome = await openStream(id, input, controller, initial, settle);
    let attempt = 0;
    while (outcome === 'dirty' && !controller.signal.aborted && attempt < MAX_RECONNECT) {
      attempt += 1;
      await sleep(Math.min(500 * 2 ** attempt, 5000), controller.signal);
      if (controller.signal.aborted) break;
      outcome = await openStream(id, input, controller, 'attach');
    }
  } catch (error) {
    // Прерывание кнопкой — не ошибка.
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      const run = runs.get(id);
      if (run) {
        runs.set(id, {
          ...run,
          error: error instanceof Error ? error.message : String(error),
          // Исключение на самом запросе — это оборванная связь, а не отказ:
          // признак временности ставим по факту обрыва, а не по тексту.
          errorRetriable: true,
        });
      }
    }
  } finally {
    controllers.delete(id);
    lastSeqs.delete(id);

    const run = runs.get(id);
    const spent = autoRetries.get(id) ?? 0;

    // Отказ «прогон уже идёт»: на сервере он ЖИВОЙ, просто эта вкладка о нём не
    // знала — сдалась после MAX_RECONNECT переподключений или открыта второй.
    // Оставить человека с одним отказом нельзя: кнопки «Остановить» на такой
    // странице нет (она появляется только у идущего прогона), и деть чужой
    // прогон было бы некуда, кроме F5. Поэтому подхватываем его потоком —
    // возвращаются и живой текст, и статус «идёт», а с ним и «Остановить».
    const takeover = Boolean(
      run?.errorCode === 'run_busy' && !controller.signal.aborted && !stoppedByUser.has(id),
    );

    // Упал по временной причине (сеть моргнула, перегрузка) — сами перезапускаем
    // тем же запросом, продолжая сессию. Пользователю ошибку не показываем и не
    // пищим: для него это просто «агент чуть задумался». Бюджет попыток ограничен.
    const willAutoRetry =
      !takeover &&
      shouldAutoRetry({
        error: run?.error,
        errorCode: run?.errorCode,
        errorRetriable: run?.errorRetriable,
        lastPrompt: run?.lastPrompt,
        spentRetries: spent,
        maxRetries: MAX_AUTO_RETRIES,
        stoppedByUser: stoppedByUser.has(id),
      });

    if (takeover) {
      const next = new AbortController();
      controllers.set(id, next);
      lastSeqs.set(id, 0);
      setRun(id, {
        status: 'running',
        error: undefined,
        errorCode: undefined,
        errorRetriable: undefined,
        lastEventAt: Date.now(),
      });
      rebuildStatuses();
      emit();
      // С нулевого seq: буфер прогона отдадут заново, и ответ виден с начала.
      void runStream(id, input, next, 'attach');
    } else if (willAutoRetry) {
      // Промпт остаётся у стора — он же его и переотправит; для поля ввода это
      // «принято», очищать текст можно.
      settle?.({ ok: true });
      autoRetries.set(id, spent + 1);
      setRun(id, {
        status: 'running',
        error: undefined,
        errorCode: undefined,
        errorRetriable: undefined,
        lastEventAt: Date.now(),
      });
      rebuildStatuses();
      emit();
      const delay = Math.min(1000 * 2 ** (spent + 1), 4000);
      autoRetryTimers.set(
        id,
        setTimeout(() => {
          if (stoppedByUser.has(id)) {
            autoRetryTimers.delete(id);
            return;
          }
          // Запись в таймерах держим до самого рестарта: авто-повтор сперва
          // читает транскрипт, и до startRun у прогона нет ни контроллера, ни
          // таймера — «Остановить всех» искало бы его и не нашло.
          void retryRun(id, { auto: true }).finally(() => autoRetryTimers.delete(id));
        }, delay),
      );
    } else {
      // Поток оборвался, не дойдя даже до ответа сервера (сеть) — считаем
      // отправку непринятой, чтобы набранный текст не пропал зря.
      settle?.({ ok: false, message: run?.error ?? 'Отправить сообщение не удалось' });
      autoRetries.delete(id);
      finalize(id);
      callbacks.onFinished?.();
      // Прогон завершён — обновляем накопленный расход с сервера.
      void loadSpend();
    }
  }
}

/**
 * Запустить (или перезапустить) прогон под данным chatId.
 *
 * Возвращает итог ПРИЁМА отправки — принял ли сервер сообщение. Раньше вызов
 * был «выстрелил и забыл», и поле ввода очищалось до ответа сервера: любой
 * отказ (прогон занят, вложение не того типа) уничтожал набранный текст.
 * Промис разрешается сразу по ответу на POST, а не по концу разговора.
 */
export function startRun(input: StartInput): Promise<SendOutcome> {
  ensureWatchdog();
  const id = input.chatId;
  // Новый запуск снимает пометку «остановлено человеком»: она относилась к
  // прошлому прогону. Бюджет авто-попыток здесь не трогаем — им заведует retry.
  stoppedByUser.delete(id);
  controllers.get(id)?.abort();
  const controller = new AbortController();
  controllers.set(id, controller);
  lastSeqs.set(id, 0);

  // Тот же разговор мог начаться под временным id (`new-…`), а продолжается уже
  // под настоящим sessionId. Старый прогон-двойник убираем, чтобы не копился.
  if (input.sessionId) {
    for (const [key, run] of runs) {
      if (key !== id && run.sessionId === input.sessionId) {
        controllers.get(key)?.abort();
        controllers.delete(key);
        runs.delete(key);
      }
    }
  }

  const prev = runs.get(id);
  // Новый ход — новый счёт: расход прошлого остался в ленте, а отложенные
  // привязки к его вызовам больше никому не адресованы.
  pendingUsage.delete(id);
  setRun(id, {
    id,
    // Идентификатор сессии — ниточка разговора, сохраняем между ходами.
    sessionId: input.sessionId ?? prev?.sessionId,
    projectPath: input.projectPath ?? prev?.projectPath,
    status: 'running',
    text: '',
    thinking: '',
    tools: [],
    tokens: 0,
    textUsage: undefined,
    costUsd: undefined,
    error: undefined,
    errorCode: undefined,
    errorRetriable: undefined,
    // Свой запуск — свой прогон: чужой серверный ключ от прошлого отказа
    // забываем, иначе поток и остановка ушли бы к чужому разговору.
    serverRunId: undefined,
    askedQuestion: false,
    permissions: [],
    // Запоминаем запрос, права, модель и глубину — для кнопки «Повторить».
    lastPrompt: input.prompt,
    // Старт по часам сервера придёт с событием session.
    startedAt: undefined,
    allowEdits: input.allowEdits,
    autoApprove: input.autoApprove,
    model: input.model,
    effort: input.effort,
    lastEventAt: Date.now(),
  });
  rebuildStatuses();
  emit();

  // Поток отвязан от вкладки: обрыв связи сам переподключается, догоняя
  // пропущенное, а сервер тем временем держит агента живым.
  return new Promise<SendOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: SendOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    void runStream(id, input, controller, 'send', settle);
  });
}

/**
 * Повторить прогон тем же запросом. `fullAccess` — перезапуск с полным
 * доступом (bypassPermissions), когда агент встал из-за прав. `auto` — это
 * автоматический перезапуск после временного сбоя: бюджет авто-попыток он не
 * обнуляет, а ручной («Повторить») — начинает счёт заново.
 */
export async function retryRun(
  id: string,
  options?: { fullAccess?: boolean; auto?: boolean },
): Promise<void> {
  const run = getRun(id);
  if (!run.lastPrompt) return;
  const key = run.id || id;
  if (!options?.auto) autoRetries.delete(key);
  // Авто-повтор не переотправляет задачу вслепую: если реплика уже в
  // транскрипте, просим продолжить с места обрыва (см. pickRetryPrompt).
  // Ручной «Повторить» — это решение человека, его отправляем как есть.
  const prompt = options?.auto ? await retryPromptFor(run) : run.lastPrompt;
  // Пока смотрели транскрипт, человек мог нажать «Остановить».
  if (options?.auto && stoppedByUser.has(key)) return;
  void startRun({
    chatId: key,
    prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    allowEdits: run.allowEdits,
    autoApprove: run.autoApprove,
    model: run.model,
    effort: run.effort,
    fullAccess: options?.fullAccess,
  });
}

/** Хвост транскрипта: своя реплика — последняя из реплик человека, дальше смотреть незачем. */
const RETRY_TAIL = 5;

/** Задача заново или «продолжай» — по тому, дожила ли реплика до транскрипта. */
async function retryPromptFor(run: AgentRun): Promise<string> {
  const lastPrompt = run.lastPrompt ?? '';
  if (!run.sessionId || run.startedAt === undefined) return lastPrompt;
  try {
    const { data } = await apiClient.get<{ messages: { role: string; timestamp: string }[] }>(
      `/chats/${run.sessionId}/messages`,
      { params: { limit: RETRY_TAIL } },
    );
    return pickRetryPrompt({
      lastPrompt,
      startedAt: run.startedAt,
      history: data.messages,
      continuation: i18n.t('chat.continueAfterDrop'),
    });
  } catch {
    // Транскрипт не прочитался — ведём себя как раньше: задача заново.
    return lastPrompt;
  }
}
