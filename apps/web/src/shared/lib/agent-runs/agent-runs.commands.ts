import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';
import { drainQueue, finalize, startRun } from './agent-runs.lifecycle';
import { autoRetries, autoRetryTimers, cancelAutoRetry, stoppedByUser } from './agent-runs.retry';
import { loadSpend } from './agent-runs.spend';
import {
  callbacks,
  caughtUp,
  controllers,
  emit,
  findKey,
  getRun,
  nextQueueSeq,
  runs,
  setRun,
} from './agent-runs.state';
import { loadQueue, persistQueue } from './agent-runs.queue-store';
import { ensureSlotsWatch, rebalance } from './agent-runs.slots';
import { ensureWatchdog, rebuildStatuses } from './agent-runs.statuses';
import type { AgentRun, HandoffEvent, QueuedMessage } from './agent-runs.types';
import { permissionDeliveryProblem } from './permissionDelivery';

/**
 * Команды стора поверх жизненного цикла: очередь дописанного, остановка,
 * подхват идущих прогонов, права и подключение колбэков страницы.
 */

/**
 * Дописать сообщение в занятый прогон. Кнопка отправки из-за этого больше не
 * блокируется: задача может идти часами, и всё это время «сказать ещё одно»
 * было нельзя — оставалось либо ждать, либо убивать агента и начинать заново.
 *
 * Возвращает id места в очереди — по нему сообщение можно отменить, пока оно
 * не ушло.
 */
export function enqueue(id: string, message: Omit<QueuedMessage, 'id'>): string {
  const key = findKey(id) ?? id;
  const queuedId = `queued-${Date.now()}-${nextQueueSeq()}`;
  const run = runs.get(key);
  setRun(key, {
    id: run?.id || key,
    queued: [...(run?.queued ?? []), { ...message, id: queuedId }],
  });
  persistQueue(key);
  emit();
  return queuedId;
}

/** Передумал — убрать дописанное из очереди, пока оно ещё не ушло агенту. */
export function cancelQueued(id: string, queuedId: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run) return;
  runs.set(key, { ...run, queued: run.queued.filter((item) => item.id !== queuedId) });
  persistQueue(key);
  emit();
}

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

/** Знаем ли мы прогон по СЕРВЕРНОМУ ключу — тому, под которым его завела чужая вкладка. */
function ownerOfServerKey(key: string): string | undefined {
  for (const [own, run] of runs) if (run.serverRunId === key) return own;
  return undefined;
}

/**
 * Подхватить прогоны, которые идут на сервере, но которых нет в этом сторе, —
 * после перезагрузки страницы. Тянем каждый с нуля, восстанавливая вывод.
 */
export async function resumeActive(): Promise<void> {
  // Заодно подтягиваем накопленный расход — чтобы счётчик не был нулём после F5.
  void loadSpend();

  let active: {
    chatId: string;
    sessionId?: string;
    projectPath?: string;
    seq: number;
    startedAt?: number;
    /** `done` — прогон закончился и лежит в grace-буфере ради догона хвоста. */
    status?: 'running' | 'done';
    /** Чем прогон запущен: у подхваченного своей записи об этом нет. */
    model?: string;
    /** Усыновлён сервером после его перезапуска: процесс жив, потока вывода нет. */
    detached?: true;
  }[];
  try {
    const response = await apiClient.get('/chat/active');
    active = response.data as typeof active;
  } catch {
    return;
  }

  ensureSlotsWatch();
  // Кого сервер назвал в этот раз — по нашим ключам. Припаркованный прогон, не
  // названный никем, кончился и вышел из grace-буфера, пока у него не было
  // потока: закрываем его ниже, иначе он «работал» бы вечно.
  const listed = new Set<string>();

  for (const info of active) {
    // Один разговор живёт в двух написаниях: временное `new-…`, под которым он
    // стартовал, и настоящий `sessionId`, под которым его знает сервер. Сверять
    // только `info.chatId` мало — вкладка, начавшая разговор, помнит его под
    // первым, а `/chat/active` называет вторым (или наоборот, после F5). Отсюда
    // и брались две строки в пульте на один разговор, две точки и два потока к
    // одному прогону; `findKey` сводит написания, для того и заведён. Третье
    // написание — ключ, под которым прогон завела чужая вкладка: мы его знаем
    // (по нему идут поток и остановка), но своим именем зовём разговор иначе.
    const known = findKey(info.chatId) ?? findKey(info.sessionId) ?? ownerOfServerKey(info.chatId);
    if (known) {
      listed.add(known);
      // Припаркованный кончился: поток ему теперь нужен только за хвостом —
      // цена, расход, вопрос, — а «работает» у законченного не показываем.
      const run = runs.get(known);
      if (run?.parked && info.status === 'done' && !run.tailOnly) {
        setRun(known, { tailOnly: true, status: 'idle', text: '', thinking: '' });
        rebuildStatuses();
        emit();
        continue;
      }
      // Новый ход разговора, чей прошлый ход у нас уже закрыт: его начал не этот
      // таб — сам CLI (кончилась фоновая задача агента), телефон или соседнее
      // окно. Раньше такой прогон пропускался, раз ключ знаком, и лента молчала
      // до перезагрузки. Новизну сверяем по серверному времени старта: ход,
      // закрытый у нас на мгновение раньше, чем на сервере, начался не позже.
      if (
        run &&
        run.status !== 'running' &&
        !run.parked &&
        !controllers.has(known) &&
        info.status === 'running' &&
        run.startedAt !== undefined &&
        info.startedAt !== undefined &&
        info.startedAt > run.startedAt
      ) {
        ensureWatchdog();
        setRun(known, {
          sessionId: info.sessionId ?? run.sessionId,
          ...(info.chatId !== known ? { serverRunId: info.chatId } : {}),
          startedAt: info.startedAt,
          ...(info.model ? { model: info.model } : {}),
          status: 'running',
          tailOnly: undefined,
          text: '',
          thinking: '',
          tools: [],
          tokens: 0,
          textUsage: undefined,
          costUsd: undefined,
          error: undefined,
          askedQuestion: false,
          permissions: [],
          stalled: undefined,
          lastEventAt: Date.now(),
          parked: true,
          ...(info.detached ? { detached: true } : {}),
        });
        rebuildStatuses();
        emit();
      }
      continue;
    }
    if (controllers.has(info.chatId)) continue;
    // Законченный прогон, чей хвост уже дотянут (тем же `startedAt`), — это не
    // новый ход, а всё та же минута grace: пропускаем, иначе он подхватывался
    // бы заново на каждом такте опроса.
    const finished = info.status === 'done';
    if (finished && caughtUp.get(info.chatId) === info.startedAt) continue;
    ensureWatchdog();
    listed.add(info.chatId);
    // Поток не открываем здесь: прогон встаёт припаркованным, а поток ему
    // раздаёт `rebalance` ниже — по приоритету и в пределах бюджета.
    setRun(info.chatId, {
      id: info.chatId,
      sessionId: info.sessionId,
      projectPath: info.projectPath,
      startedAt: info.startedAt,
      // Чем ведётся: событие сессии назовёт то же имя, но оно придёт с потоком,
      // а поток припаркованному прогону достаётся не сразу.
      model: info.model,
      // Законченный заводим сразу законченным: «работает» у него не будет ни
      // секунды, а поток ниже дотянет только хвост — цену, расход, вопрос.
      status: finished ? 'idle' : 'running',
      tailOnly: finished,
      text: '',
      thinking: '',
      tools: [],
      tokens: 0,
      textUsage: undefined,
      costUsd: undefined,
      error: undefined,
      askedQuestion: false,
      permissions: [],
      lastEventAt: Date.now(),
      // Дописанное, пережившее перезагрузку: прогон тот же, значит и очередь
      // его — уйдёт по концу хода, как ушла бы без перезагрузки.
      queued: loadQueue(info.sessionId, info.chatId),
      parked: true,
      // Подхваченный сервером без потока: пузыря не будет и после того, как
      // поток достанется, — ставим метку здесь, до первого события.
      ...(info.detached ? { detached: true } : {}),
    });
    rebuildStatuses();
    emit();
  }

  // Припаркованные, которых сервер больше не называет, кончились без нас.
  // Обрывок текста у такого не правда — правда в транскрипте, поэтому
  // закрываем его как потерявший связь: лента покажет историю целиком.
  for (const [key, run] of runs) {
    if (!run.parked || controllers.has(key) || listed.has(key)) continue;
    setRun(key, { parked: undefined, stalled: true });
    finalize(key);
  }

  rebalance();
}

/**
 * Прогоны остановил сервер по решению человека («Отменить план»): дописанное
 * в их очередь не уходит, а сбой конца хода не перезапускается — как после
 * «Остановить». Сам прогон сервер уже снял, звать `/stop` незачем (F3).
 */
export function haltQueued(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    const key = findKey(id) ?? id;
    stoppedByUser.add(key);
    stoppedByUser.add(id);
    cancelAutoRetry(key);
    cancelAutoRetry(id);
    const run = runs.get(key);
    if (run && run.queued.length > 0) {
      runs.set(key, { ...run, queued: [] });
      persistQueue(key);
      changed = true;
    }
  }
  if (changed) emit();
}

/**
 * Остановить прогон: сервер убивает процесс, клиент перестаёт читать поток.
 *
 * Снимаем и отложенный авто-рестарт — иначе через пару секунд таймер поднимет
 * агента снова, уже после нажатия «Остановить». Не подтвердил сервер остановку
 * — говорим об этом: процесс мог остаться жив, и молча писать «остановлено»
 * значит врать.
 */
export function stopRun(id: string): void {
  const key = findKey(id) ?? id;
  stoppedByUser.add(key);
  stoppedByUser.add(id);
  // Остановка гасит и очередь: человек прервал работу, а дописанное ушло бы
  // сразу после — получилось бы, что кнопка «Остановить» ничего не остановила.
  const queuedRun = runs.get(key);
  if (queuedRun && queuedRun.queued.length > 0) {
    runs.set(key, { ...queuedRun, queued: [] });
    persistQueue(key);
  }
  cancelAutoRetry(key);
  cancelAutoRetry(id);
  // Прогон мог быть заведён другой вкладкой под своим ключом (serverRunId) —
  // останавливать надо именно его, иначе сервер ответит «прогона нет», а
  // агент продолжит работать.
  const target = runs.get(key)?.serverRunId ?? key;
  void apiClient.post(`/chat/${target}/stop`).catch((error: unknown) => {
    const run = runs.get(key);
    if (!run) return;
    runs.set(key, {
      ...run,
      error: error instanceof Error ? error.message : String(error),
    });
    emit();
  });
  const controller = controllers.get(key);
  controller?.abort();
  // Контроллера нет — прогон уже дочитан и ждал отложенного авто-рестарта.
  // Оборвать нечего, и без этого он навис бы «идущим» навсегда: поток
  // завершён, таймер только что снят, а финализировать его больше некому.
  if (!controller) finalize(key);
}

/**
 * Продолжить упавший/остановленный разговор: просим агента продолжить с того
 * места, где он замолчал, не переспрашивая исходную задачу. Сессию не теряем.
 */
export function continueRun(id: string, prompt: string): void {
  const run = getRun(id);
  autoRetries.delete(run.id || id);
  void startRun({
    chatId: run.id || id,
    prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    allowEdits: run.allowEdits,
    autoApprove: run.autoApprove,
    model: run.model,
    effort: run.effort,
  });
}

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

/** Убрать прогон из стора (например, когда его ответ уже есть в истории). */
export function clearRun(id: string): void {
  const key = findKey(id);
  if (!key) return;
  controllers.get(key)?.abort();
  controllers.delete(key);
  runs.delete(key);
  rebuildStatuses();
  emit();
}

/**
 * Спрятать потоковый текст прогона, сохранив статус: когда ответ уже есть в
 * истории, дубль на экране не нужен, но жёлтая/красная точка (вопрос/ошибка)
 * должна остаться.
 *
 * Здесь же снимается метка потерянного потока: она говорит «ответ ищите в
 * переписке», а переписка только что показана — дальше это была бы строка о
 * беде, которой уже нет.
 */
export function quietRun(id: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run) return;
  runs.set(key, { ...run, text: '', thinking: '', tools: [], dropped: undefined });
  emit();
}

/** Колбэк по завершении любого прогона — страница обновляет список чатов. */
export function setOnFinished(callback: (() => void) | undefined): void {
  callbacks.onFinished = callback;
}

/** Какой чат открыт на экране — чтобы не уведомлять о его же завершении. */
export function setActiveId(id: string | undefined): void {
  callbacks.activeId = id;
  // Открытый разговор — первый в очереди за потоком.
  rebalance();
}

/** Колбэк по завершении ФОНОВОГО проектного прогона — для тоста-уведомления. */
export function setOnBackgroundEvent(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onBackgroundEvent = callback;
}

/** Колбэк на новый запрос прав любого прогона — звук/тост/карточка. */
export function setOnPermissionRequest(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onPermissionRequest = callback;
}

/** Колбэк на продолжение в чистой сессии — переезд вкладки и тост. */
export function setOnHandoff(
  callback: ((event: HandoffEvent, run: AgentRun) => void) | undefined,
): void {
  callbacks.onHandoff = callback;
}

/**
 * Переключить автоподтверждение прав у идущего прогона. Без этого новое
 * положение тумблера подействовало бы только со следующего сообщения — а
 * щёлкают его как раз посреди прогона, устав жать «Разрешить».
 */
export function setAutoApprove(id: string, enabled: boolean): void {
  const run = getRun(id);
  const key = run.id || id;
  if (!key) return;
  const current = runs.get(key);
  if (current) {
    runs.set(key, { ...current, autoApprove: enabled });
    emit();
  }
  if (run.status !== 'running') return;
  // Прогон мог быть заведён другой вкладкой под своим ключом (serverRunId) —
  // тумблер должен дойти именно до него, как и остановка.
  const target = current?.serverRunId ?? key;
  void apiClient.post(`/chat/${target}/auto-approve`, { enabled }).catch(() => undefined);
}

/**
 * Ответить воротам ветки. Карточку гасим только на успехе, и это не
 * осторожность: «завести копию» может не пройти у самого git (занятое имя,
 * грязная копия), а придержанная правка всё это время жива. Сняли бы карточку
 * сразу — человек остался бы с идущим прогоном, который стоит, и без единой
 * кнопки, чтобы ответить.
 */
export async function decideBranchGate(
  id: string,
  toolUseId: string,
  choice: 'copy' | 'here' | 'stop',
  branch?: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const run = getRun(id);
  const key = run.id || id;
  const current = runs.get(key);
  const target = current?.serverRunId ?? key;
  try {
    const { data } = await apiClient.post(`/chat/${target}/branch-decision`, {
      toolUseId,
      choice,
      ...(branch ? { branch } : {}),
    });
    const answer = data as { ok?: unknown; path?: unknown; message?: unknown };
    if (answer?.ok !== true) {
      return {
        ok: false,
        ...(typeof answer?.message === 'string' ? { error: answer.message } : {}),
      };
    }
    const after = runs.get(key);
    if (after) {
      runs.set(key, {
        ...after,
        branchGates: after.branchGates.filter((gate) => gate.toolUseId !== toolUseId),
      });
      rebuildStatuses();
      emit();
    }
    return { ok: true, ...(typeof answer.path === 'string' ? { path: answer.path } : {}) };
  } catch (error) {
    const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data;
    return {
      ok: false,
      ...(typeof body?.message === 'string' ? { error: body.message } : {}),
    };
  }
}

/** Ответить на запрос прав (клик «Разрешить»/«Запретить»). */
export function decidePermission(
  id: string,
  toolUseId: string,
  behavior: 'allow' | 'deny',
  message?: string,
): void {
  const run = getRun(id);
  const key = run.id || id;
  // Локально убираем карточку сразу — не ждём эха с сервера.
  const current = runs.get(key);
  if (current) {
    runs.set(key, {
      ...current,
      permissions: current.permissions.filter((p) => p.toolUseId !== toolUseId),
    });
    rebuildStatuses();
    emit();
  }
  // …но если решение до брокера не дошло, об этом надо сказать: карточки уже
  // нет, а агент всё ещё стоит и ждёт — молчание здесь выглядит как «ответил».
  const target = current?.serverRunId ?? key;
  void apiClient
    .post(`/chat/${target}/permission-decision`, { toolUseId, behavior, message })
    .then(({ data }) => permissionDeliveryProblem(data as { ok?: unknown }))
    .catch((error: unknown) => permissionDeliveryProblem(undefined, error ?? 'network'))
    .then((problem) => {
      if (problem) toast.error(i18n.t(problem));
    });
}
