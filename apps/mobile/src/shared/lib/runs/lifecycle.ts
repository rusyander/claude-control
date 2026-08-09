import { AppState } from 'react-native';
import { api } from '../../api/client';
import { dict } from '../../config/i18n';
import { notifyLocally } from '../notifications';
import { openStream } from './stream';
import { controllers, emit, forgetRun, getRun, lastSeqs, runs, setRun } from './store';
import { EMPTY_RUN, type QueuedMessage, type SendOutcome, type StartInput } from './types';

/**
 * Жизненный цикл прогона: запуск, переподключение, остановка, очередь.
 *
 * Переподключение здесь не роскошь, а основной режим: телефон гасит экран и
 * выгружает вкладку, поток рвётся, а прогон на сервере продолжается. Поэтому
 * оборванный поток без терминального события — повод подключиться заново с
 * последнего seq, а не считать работу законченной.
 */

const RECONNECT_DELAY_MS = 1_500;
const RECONNECT_LIMIT = 20;

/** Прогоны, остановленные человеком: им переподключаться не надо. */
const stoppedByUser = new Set<string>();

/** Ключ, под которым прогон известен серверу. */
function serverKey(id: string): string {
  return runs.get(id)?.serverRunId ?? id;
}

/**
 * Держать поток открытым, пока прогон не закончится. Каждый обрыв без терминала
 * — переподключение с догоном; потолок попыток нужен, чтобы мёртвый сервер не
 * крутил цикл вечно.
 */
async function keepStreaming(
  id: string,
  input: StartInput,
  controller: AbortController,
  mode: 'send' | 'attach',
  settle?: (outcome: SendOutcome) => void,
): Promise<void> {
  let attempts = 0;
  let currentMode = mode;

  for (;;) {
    let outcome: Awaited<ReturnType<typeof openStream>>;
    try {
      outcome = await openStream(id, input, controller, currentMode, settle);
    } catch (error) {
      if (controller.signal.aborted) return;
      outcome = 'dirty';
      if (attempts === 0 && currentMode === 'send') {
        // Первая же попытка отправки не дошла до сервера — это отказ, а не
        // обрыв: сообщение не принято, и человеку надо сказать прямо.
        const message = error instanceof Error ? error.message : dict().run.serverUnreachable;
        setRun(id, { status: 'error', error: message });
        settle?.({ ok: false, message });
        emit();
        return;
      }
    }
    // Отправка удалась ровно один раз: дальше только переподключение.
    currentMode = 'attach';
    settle = undefined;

    if (outcome === 'clean' || outcome === 'refused') break;
    if (outcome === 'gone') {
      forgetRun(id);
      return;
    }
    if (stoppedByUser.has(id) || controller.signal.aborted) break;
    if (++attempts > RECONNECT_LIMIT) {
      setRun(id, { status: 'error', error: dict().run.connectionLost });
      emit();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }

  finish(id);
}

/** Прогон закончился: статус, чистка контроллера и отправка очереди. */
function finish(id: string): void {
  const run = getRun(id);
  const status = stoppedByUser.has(id) ? 'stopped' : run.error ? 'error' : 'done';
  const wasStopped = stoppedByUser.has(id);
  setRun(id, { status });
  controllers.delete(id);
  stoppedByUser.delete(id);
  emit();

  // Сигнал в шторку — только если экран не смотрят и остановку не просили сами.
  // Это запасной путь к push-уведомлениям: он работает, пока приложение живо в
  // фоне, и молчит, когда человек и так видит ленту.
  if (!wasStopped && AppState.currentState !== 'active' && run.queued.length === 0) {
    const t = dict().run;
    const name = run.projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? t.homeChat;
    void notifyLocally(
      status === 'error' ? t.failed : t.finished,
      status === 'error' ? (run.error ?? name) : name,
    ).catch(() => undefined);
  }

  void flushQueue(id);
}

/**
 * Отправить сообщение. Возвращает, ПРИНЯТО ли оно: поле ввода очищается только
 * после этого, иначе отказ уничтожает набранный текст.
 */
export async function send(input: StartInput): Promise<SendOutcome> {
  const id = input.chatId;
  const existing = runs.get(id);
  if (existing?.status === 'running') {
    // Агент занят — сообщение уходит в очередь, а не теряется и не плодит
    // второй процесс на тот же разговор.
    enqueue(id, {
      prompt: input.prompt,
      allowEdits: input.allowEdits,
      autoApprove: input.autoApprove,
      model: input.model,
      effort: input.effort,
      files: input.files,
    });
    return { ok: true };
  }

  const controller = new AbortController();
  controllers.set(id, controller);
  stoppedByUser.delete(id);
  lastSeqs.set(id, 0);
  setRun(id, {
    ...EMPTY_RUN,
    id,
    sessionId: input.sessionId,
    projectPath: input.projectPath,
    status: 'running',
    lastPrompt: input.prompt,
    allowEdits: input.allowEdits,
    autoApprove: input.autoApprove,
    model: input.model,
    effort: input.effort,
    queued: existing?.queued ?? [],
    lastEventAt: Date.now(),
  });
  emit();

  return new Promise<SendOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: SendOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    void keepStreaming(id, input, controller, 'send', settle).then(() => settle({ ok: true }));
  });
}

/** Подключиться к прогону, который идёт на сервере (после запуска приложения). */
export function attach(id: string, meta: { sessionId?: string; projectPath?: string }): void {
  if (controllers.has(id)) return;
  const controller = new AbortController();
  controllers.set(id, controller);
  lastSeqs.set(id, 0);
  setRun(id, {
    ...EMPTY_RUN,
    id,
    sessionId: meta.sessionId,
    projectPath: meta.projectPath,
    status: 'running',
    lastEventAt: Date.now(),
  });
  emit();
  void keepStreaming(id, { chatId: id, prompt: '' }, controller, 'attach');
}

/**
 * Подхватить всё, что идёт на сервере. Вызывается при запуске приложения и при
 * возвращении из фона: пока телефон спал, прогон мог и начаться, и кончиться.
 */
export async function resumeActive(): Promise<void> {
  let active: { chatId: string; sessionId?: string; projectPath?: string; seq: number }[];
  try {
    active = await api.get('/chat/active');
  } catch {
    return;
  }
  for (const info of active) attach(info.chatId, info);
}

/** Остановить прогон. Сервер гасит процесс, поток закрывается сам. */
export async function stop(id: string): Promise<void> {
  stoppedByUser.add(id);
  try {
    await api.post(`/chat/${encodeURIComponent(serverKey(id))}/stop`);
  } catch {
    // Прогона уже нет — состояние всё равно приведём к остановленному.
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  setRun(id, { status: 'stopped' });
  emit();
}

/** Ответить на запрос прав. Карточка исчезнет по событию от сервера. */
export async function decidePermission(
  id: string,
  toolUseId: string,
  behavior: 'allow' | 'deny',
): Promise<void> {
  await api.post(`/chat/${encodeURIComponent(serverKey(id))}/permission-decision`, {
    toolUseId,
    behavior,
  });
}

/** Автоподтверждение безопасных запросов прав для этого прогона. */
export async function setAutoApprove(
  id: string,
  enabled: boolean,
  allowEdits: boolean,
): Promise<void> {
  await api.post(`/chat/${encodeURIComponent(serverKey(id))}/auto-approve`, {
    enabled,
    allowEdits,
  });
  setRun(id, { autoApprove: enabled, allowEdits });
  emit();
}

export function enqueue(id: string, message: Omit<QueuedMessage, 'id'>): string {
  const run = getRun(id);
  const queuedId = `q-${Date.now()}-${run.queued.length}`;
  setRun(id, { queued: [...run.queued, { ...message, id: queuedId }] });
  emit();
  return queuedId;
}

export function cancelQueued(id: string, queuedId: string): void {
  const run = getRun(id);
  setRun(id, { queued: run.queued.filter((item) => item.id !== queuedId) });
  emit();
}

/** Агент освободился — отправляем первое из дописанного тем же разговором. */
async function flushQueue(id: string): Promise<void> {
  const run = getRun(id);
  const [next, ...rest] = run.queued;
  if (!next) return;
  setRun(id, { queued: rest });
  emit();
  await send({
    chatId: id,
    prompt: next.prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    allowEdits: next.allowEdits,
    autoApprove: next.autoApprove,
    model: next.model,
    effort: next.effort,
    files: next.files,
  });
}
