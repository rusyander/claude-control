import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';
import { finalize, runStream, startRun } from './agent-runs.lifecycle';
import { autoRetries, autoRetryTimers, cancelAutoRetry, stoppedByUser } from './agent-runs.retry';
import { loadSpend } from './agent-runs.spend';
import {
  callbacks,
  controllers,
  emit,
  findKey,
  getRun,
  lastSeqs,
  nextQueueSeq,
  runs,
  setRun,
} from './agent-runs.state';
import { ensureWatchdog, rebuildStatuses } from './agent-runs.statuses';
import type { AgentRun, QueuedMessage } from './agent-runs.types';
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
  emit();
}

/**
 * Подхватить прогоны, которые идут на сервере, но которых нет в этом сторе, —
 * после перезагрузки страницы. Тянем каждый с нуля, восстанавливая вывод.
 */
export async function resumeActive(): Promise<void> {
  // Заодно подтягиваем накопленный расход — чтобы счётчик не был нулём после F5.
  void loadSpend();

  let active: { chatId: string; sessionId?: string; projectPath?: string; seq: number }[];
  try {
    const response = await apiClient.get('/chat/active');
    active = response.data as typeof active;
  } catch {
    return;
  }

  for (const info of active) {
    if (runs.has(info.chatId) || controllers.has(info.chatId)) continue;
    ensureWatchdog();
    const controller = new AbortController();
    controllers.set(info.chatId, controller);
    lastSeqs.set(info.chatId, 0);
    setRun(info.chatId, {
      id: info.chatId,
      sessionId: info.sessionId,
      projectPath: info.projectPath,
      status: 'running',
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
    });
    rebuildStatuses();
    emit();
    void runStream(info.chatId, { chatId: info.chatId, prompt: '' }, controller, 'attach');
  }
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
  if (queuedRun && queuedRun.queued.length > 0) runs.set(key, { ...queuedRun, queued: [] });
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
 */
export function quietRun(id: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run) return;
  runs.set(key, { ...run, text: '', thinking: '', tools: [] });
  emit();
}

/** Колбэк по завершении любого прогона — страница обновляет список чатов. */
export function setOnFinished(callback: (() => void) | undefined): void {
  callbacks.onFinished = callback;
}

/** Какой чат открыт на экране — чтобы не уведомлять о его же завершении. */
export function setActiveId(id: string | undefined): void {
  callbacks.activeId = id;
}

/** Колбэк по завершении ФОНОВОГО проектного прогона — для тоста-уведомления. */
export function setOnBackgroundEvent(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onBackgroundEvent = callback;
}

/** Колбэк на новый запрос прав любого прогона — звук/тост/карточка. */
export function setOnPermissionRequest(callback: ((run: AgentRun) => void) | undefined): void {
  callbacks.onPermissionRequest = callback;
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
  void apiClient.post(`/chat/${key}/auto-approve`, { enabled }).catch(() => undefined);
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
  void apiClient
    .post(`/chat/${key}/permission-decision`, { toolUseId, behavior, message })
    .then(({ data }) => permissionDeliveryProblem(data as { ok?: unknown }))
    .catch((error: unknown) => permissionDeliveryProblem(undefined, error ?? 'network'))
    .then((problem) => {
      if (problem) toast.error(i18n.t(problem));
    });
}
