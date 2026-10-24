import { AppState } from 'react-native';
import { api } from '../../api/client';
import { openStream } from './stream';
import {
  EMPTY_RUN,
  TURN_RESET,
  type ActiveRunInfo,
  type AgentRun,
  type QueuedMessage,
  type SendOutcome,
  type StartInput,
} from './types';
import { isConfigured } from '../../api/connection';
import { dict } from '../../config/i18n';
import { notifyLocally } from '../notifyLocally';
import { persistQueue } from './persistQueue';
import { loadQueue } from './loadQueue';
import {
  emit,
  runs,
  getRun,
  setRun,
  findRunKey,
  lastSeqs,
  controllers,
  forgetAllRuns,
  discarded,
} from './store';

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
/** Переподключения кончились: связи с прогоном нет, а сам он, может, и жив. */
const CONNECTION_LOST = 'connection_lost';
/** Отправка не дошла до панели по сети: досылка из очереди повторится, когда та ответит. */
const UNREACHABLE = 'unreachable';

/** Прогоны, остановленные человеком: им переподключаться не надо. */
const stoppedByUser = new Set<string>();
/** Очереди, досылка которых уже идёт: опрос и конец хода не шлют одно и то же дважды. */
const flushing = new Set<string>();

/** Метка сообщения: повтор уже принятого сервер узнаёт по ней (`SentOnce`). */
function newClientId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  // Сервер отказал в самой отправке: хода не было, и очереди досылать нечего —
  // иначе вернувшееся в неё сообщение уходило бы снова и снова по кругу отказов.
  let refusedSend = false;
  // Отказ «занят» на первой отправке не отдаётся вызывающему: прогон ниже
  // подхватывается, а сообщение встаёт в очередь — ответ принят (F-67).
  let busyHeld: ((outcome: SendOutcome) => void) | undefined;
  const firstSettle =
    settle &&
    ((outcome: SendOutcome): void => {
      if (!outcome.ok && outcome.code === 'run_busy' && input.prompt) busyHeld = settle;
      else settle?.(outcome);
    });

  for (;;) {
    let outcome: Awaited<ReturnType<typeof openStream>>;
    try {
      outcome = await openStream(id, input, controller, currentMode, settle && firstSettle);
    } catch {
      if (controller.signal.aborted) return;
      outcome = 'dirty';
      if (attempts === 0 && currentMode === 'send') {
        // Первая же попытка отправки не дошла до сервера — это отказ, а не
        // обрыв: сообщение не принято, и человеку надо сказать прямо. Текст
        // ошибки транспорта («Network request failed») человеку ничего не
        // говорит — говорим своими словами. Контроллер снимаем: оставленный, он
        // запирал разговор от опроса, и ход, который запрос всё-таки успел
        // начать, телефон не подхватывал до перезапуска.
        const t = dict().run;
        const message = t.notSent.other(t.serverUnreachable);
        setRun(id, {
          status: 'error',
          error: message,
          errorCode: UNREACHABLE,
          ...(input.prompt && input.clientId
            ? { unsent: { prompt: input.prompt, clientId: input.clientId } }
            : {}),
        });
        if (controllers.get(id) === controller) controllers.delete(id);
        settle?.({ ok: false, message });
        emit();
        return;
      }
    }
    // Отправка удалась ровно один раз: дальше только переподключение.
    currentMode = 'attach';
    settle = undefined;

    if (outcome === 'clean') break;
    if (outcome === 'refused') {
      // Отказ «прогон уже идёт»: на сервере он ЖИВОЙ — его начали с компьютера
      // или из другого окна, а телефон о нём не знал. Оставить человека с одним
      // отказом нельзя: кнопки «Стоп» у ошибки нет. Подхватываем прогон потоком
      // по ключу из отказа (`serverRunId`) — возвращаются и живой текст, и
      // «Стоп». Непринятое сообщение встаёт в очередь и уходит по концу хода.
      const refused = getRun(id);
      if (
        refused.errorCode === 'run_busy' &&
        !stoppedByUser.has(id) &&
        !controller.signal.aborted
      ) {
        lastSeqs.set(id, 0);
        setRun(id, {
          status: 'running',
          error: undefined,
          errorCode: undefined,
          errorRetriable: undefined,
          // Непринятый промпт — не «своя задача» над чужим ответом.
          lastPrompt: undefined,
          lastEventAt: Date.now(),
        });
        // Сервер сообщение не принял, а человек его отправил (ответ из «Вопросов»,
        // поле ввода): оно уходит по концу этого хода, как у занятого агента.
        if (busyHeld) {
          enqueue(id, {
            prompt: input.prompt,
            allowEdits: input.allowEdits,
            autoApprove: input.autoApprove,
            model: input.model,
            effort: input.effort,
            files: input.files,
            // Отказ «занят» метку не запомнил — с ней же сообщение и дошлётся.
            ...(input.clientId ? { clientId: input.clientId } : {}),
          });
          busyHeld({ ok: true });
          busyHeld = undefined;
        }
        emit();
        attempts = 0;
        continue;
      }
      // Подхватить не вышло (остановлено) — отказ отдаём, как он есть.
      busyHeld?.({ ok: false, code: 'run_busy', message: refused.error ?? '' });
      refusedSend = true;
      break;
    }
    if (outcome === 'gone') {
      // Прогона на сервере больше нет — ход кончился, пока связи не было. Раньше
      // запись разговора стиралась целиком: вместе с ней — очередь дописанного
      // (до следующего открытия чата) и сессия, по которой черновик `new-…`
      // становится настоящим разговором. Ход закрываем как законченный: экран
      // перечитает транскрипт, очередь уйдёт. В шторку не сообщаем — чем он
      // кончился, телефон не видел.
      if (discarded.has(controller)) return;
      finish(id, true, true);
      return;
    }
    if (stoppedByUser.has(id) || controller.signal.aborted) break;
    // Поток жил и оборвался (сон телефона, смена сети) — связь была. Счёт
    // попыток с нуля: иначе долгий ход, переживший двадцать таких обрывов,
    // объявлялся бы потерянным при живой связи.
    if (outcome === 'broken') attempts = 0;
    if (++attempts > RECONNECT_LIMIT) {
      // Переподключения исчерпаны: прогон, может, и жив, но связи с ним нет.
      // Ошибка со словами «связь потеряна» честнее вечного «работает», а конец
      // хода заставит экран перечитать историю — ответ, если он есть, там. Код
      // ошибки нужен опросу: такой прогон он подхватывает заново, тот же это
      // ход или новый, а законченный — закрывает и отдаёт очередь.
      setRun(id, {
        status: 'error',
        error: dict().run.connectionLost,
        errorCode: CONNECTION_LOST,
        stalled: undefined,
      });
      controllers.delete(id);
      emit();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    if (controller.signal.aborted) break;
  }

  if (discarded.has(controller)) return;
  finish(id, !refusedSend);
}

/**
 * Прогон закончился: статус, чистка контроллера и отправка очереди. `quiet` —
 * конец, которого телефон не видел (прогона на сервере уже нет): в шторку о нём
 * не сообщаем.
 */
function finish(id: string, flush = true, quiet = false): void {
  const run = getRun(id);
  const status = stoppedByUser.has(id) ? 'stopped' : run.error ? 'error' : 'done';
  const wasStopped = stoppedByUser.has(id);
  // Переданное на ходу теперь в транскрипте — строкой в ленте, не дублем.
  // Отметка конца — экрану: перечитать транскрипт, даже если «работает» он не видел.
  setRun(id, { status, stalled: undefined, steered: undefined, endedAt: Date.now() });
  controllers.delete(id);
  stoppedByUser.delete(id);
  emit();
  // К концу хода сессия уже известна — очередь переезжает под её имя.
  void persistQueue(id);

  // Сигнал в шторку — только если экран не смотрят и остановку не просили сами.
  // Это запасной путь к push-уведомлениям: он работает, пока приложение живо в
  // фоне, и молчит, когда человек и так видит ленту. Прогон, подхваченный уже
  // законченным, не событие: он кончился до того, как приложение посмотрело.
  if (
    !wasStopped &&
    !quiet &&
    !run.tailOnly &&
    AppState.currentState !== 'active' &&
    run.queued.length === 0
  ) {
    const t = dict().run;
    const name = run.projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? t.homeChat;
    void notifyLocally(
      status === 'error' ? t.failed : t.finished,
      status === 'error' ? (run.error ?? name) : name,
      { chatId: run.sessionId ?? id, projectPath: run.projectPath ?? '' },
    ).catch(() => undefined);
  }

  if (flush) void flushQueue(id);
}

/**
 * Слово агенту посреди хода. `steered` — агент его получил; `ended` — сервер
 * ответил, что хода уже нет (409 `run_steer_ended`): «идущий» прогон на телефоне
 * — устаревший; `failed` — не принято по другой причине (сеть, прогон без живой
 * сессии) — дальше очередь.
 * `clientId` — на случай, когда сервер слово отдал, а ответ до телефона не дошёл
 * (сон приложения, сеть): с ней же оно встанет в очередь, и досылку сервер
 * узнает как повтор, а не отдаст агенту второй раз (карточка 33).
 */
async function steer(
  run: AgentRun,
  input: StartInput,
  clientId: string,
): Promise<'steered' | 'ended' | 'failed'> {
  try {
    const reply = await api.post<{ steered?: boolean }>('/chat/send', {
      chatId: run.serverRunId ?? run.id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.projectPath ? { projectPath: run.projectPath } : {}),
      prompt: input.prompt,
      steer: true,
      clientId,
    });
    if (!reply?.steered) return 'failed';
    const current = runs.get(run.id);
    if (current && !(current.steered ?? []).includes(input.prompt)) {
      setRun(run.id, { steered: [...(current.steered ?? []), input.prompt] });
      emit();
    }
    return 'steered';
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'run_steer_ended' ? 'ended' : 'failed';
  }
}

/**
 * Сервер сказал прямо: хода нет. Поток, за которым телефон его вёл, — старый
 * (оборван и переподключается, а то и вовсе замолчал): ждать его конца, чтобы
 * отдать очередь, значило бы держать написанное, пока поток не сдастся — или
 * вечно. Поток отпускаем, ход закрываем — очередь уходит сейчас.
 */
function closeStale(id: string): void {
  const stale = controllers.get(id);
  if (stale) {
    discarded.add(stale);
    stale.abort();
  }
  if (getRun(id).status === 'running') finish(id, true, true);
  else void flushQueue(id);
}

/**
 * Отправить сообщение. Возвращает, ПРИНЯТО ли оно: поле ввода очищается только
 * после этого, иначе отказ уничтожает набранный текст.
 */
export async function send(input: StartInput): Promise<SendOutcome> {
  const id = input.chatId;
  const existing = runs.get(id);
  if (existing?.status === 'running') {
    // Агент занят — слово уходит ему сразу, как в самом Claude Code: он учтёт
    // его на ближайшем шаге, не дожидаясь конца всей работы. Вложения и прогон
    // без живой сессии — в очередь: не теряется и не плодит второй процесс.
    const clientId = newClientId('steer');
    const steered =
      (input.files?.length ?? 0) === 0 ? await steer(existing, input, clientId) : 'failed';
    if (steered === 'steered') return { ok: true };
    enqueue(id, {
      prompt: input.prompt,
      allowEdits: input.allowEdits,
      autoApprove: input.autoApprove,
      model: input.model,
      effort: input.effort,
      files: input.files,
      clientId,
    });
    if (steered === 'ended') closeStale(id);
    // Ход кончился, пока шёл запрос «на ходу»: конец хода очередь уже не снимет.
    else if (getRun(id).status !== 'running') void flushQueue(id);
    return { ok: true };
  }

  // Метка отправки. Тот же текст после сетевого отказа — с той же меткой: если
  // первый запрос всё же дошёл, сервер узнает повтор и второй раз агенту не отдаст.
  const clientId =
    input.clientId ??
    (existing?.unsent?.prompt === input.prompt ? existing.unsent.clientId : newClientId('send'));
  // Поток под этим ключом ещё мог дочитывать хвост законченного хода: его
  // конец и расход не должны лечь на ход, начатый сейчас.
  const prior = controllers.get(id);
  if (prior) {
    discarded.add(prior);
    prior.abort();
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  stoppedByUser.delete(id);
  lastSeqs.set(id, 0);
  setRun(id, {
    ...EMPTY_RUN,
    ...TURN_RESET,
    // Новый ход заводит свой `startedAt` событием сессии; прежний не должен
    // выдавать курсор нового за курсор старого хода.
    startedAt: undefined,
    unsent: undefined,
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
    void keepStreaming(id, { ...input, clientId }, controller, 'send', settle).then(() =>
      settle({ ok: true }),
    );
  });
}

/**
 * Подключиться к прогону, который идёт на сервере (после запуска приложения и
 * по опросу `/chat/active`).
 *
 * Разговор ищем под любым его написанием (`findRunKey`): временный `new-…`,
 * сессия, серверный ключ — иначе один прогон заводился бы дважды. Уже
 * известный не трогаем: идущий — поток за ним и так открыт; законченный с тем
 * же `startedAt` — это он же, ещё минуту висящий в списке для догона, а не
 * новый ход. Подхватывать его заново значило бы каждые пять секунд стирать
 * ответ и печатать его с нуля. Новый ход в том же разговоре приходит с другим
 * `startedAt` — его берём.
 *
 * Прогон, который сервер называет законченным (`status: 'done'`), заводим сразу
 * законченным: ни одного мгновения «работает», текст в пузырь не набирается —
 * ответ давно в истории; поток дотягивает лишь хвост (расход, вопрос).
 *
 * Исключение из «уже известного» — прогон, связь с которым телефон потерял
 * (переподключения кончились) или который числится идущим без потока: такой
 * подхватываем заново, даже с тем же `startedAt`. Раньше он отсеивался как
 * «тот же ход» навсегда, и ход показывался только после перезапуска приложения.
 */
export function attach(
  id: string,
  meta: Omit<ActiveRunInfo, 'chatId' | 'seq'> & { seq?: number },
): void {
  const key = findRunKey(id, meta.sessionId) ?? id;
  if (controllers.has(key)) return;
  const known = runs.get(key);
  const lost = known?.status === 'running' || known?.errorCode === CONNECTION_LOST;
  if (!lost && known && meta.startedAt !== undefined && known.startedAt === meta.startedAt) return;

  const finished = meta.status === 'done';
  const controller = new AbortController();
  controllers.set(key, controller);
  lastSeqs.set(key, 0);
  setRun(key, {
    ...EMPTY_RUN,
    ...TURN_RESET,
    id: key,
    sessionId: meta.sessionId ?? known?.sessionId,
    projectPath: meta.projectPath ?? known?.projectPath,
    // Сервер зовёт разговор иначе, чем телефон, — поток и команды идут по его имени.
    serverRunId: key === id ? known?.serverRunId : id,
    startedAt: meta.startedAt,
    status: finished ? 'done' : 'running',
    tailOnly: finished || undefined,
    queued: known?.queued ?? [],
    // Не дошедшая отправка могла как раз и начать этот ход: её метка нужна повтору.
    unsent: known?.unsent,
    lastEventAt: Date.now(),
  });
  emit();
  void keepStreaming(key, { chatId: key, prompt: '' }, controller, 'attach');
}

/**
 * Подхватить всё, что идёт на сервере. Вызывается при запуске приложения и при
 * возвращении из фона: пока телефон спал, прогон мог и начаться, и кончиться.
 */
export async function resumeActive(): Promise<void> {
  // Без адреса панели спрашивать некого — и ошибку «не настроено» плодить незачем.
  if (!isConfigured()) return;
  let active: ActiveRunInfo[];
  try {
    active = await api.get('/chat/active');
  } catch {
    return;
  }
  const named = new Set<string>();
  for (const info of active) {
    attach(info.chatId, info);
    const key = findRunKey(info.chatId, info.sessionId);
    if (key) named.add(key);
  }
  settleOrphans(named);
}

/**
 * Панель ответила — значит, связь есть, и то, что телефон держит без потока,
 * можно свести с правдой сервера. Прогон, с которым связь была потеряна (или
 * «идущий» без потока), которого сервер больше не называет, кончился, пока
 * связи не было: закрываем его, ошибку «связь потеряна» снимаем, очередь
 * уходит. Досылка, не дошедшая по сети, повторяется сейчас; отказ сервера
 * («группа на паузе», «занят») — нет: тот снимает человек или конец хода.
 */
function settleOrphans(named: Set<string>): void {
  for (const [key, run] of [...runs]) {
    if (named.has(key) || controllers.has(key)) continue;
    if (run.status === 'running' || run.errorCode === CONNECTION_LOST) {
      setRun(key, { error: undefined, errorCode: undefined, errorRetriable: undefined });
      finish(key, true, true);
    } else if (run.errorCode === UNREACHABLE && run.queued.length > 0) {
      void flushQueue(key);
    }
  }
}

/**
 * Выбран другой компьютер. Прогоны прежнего продолжаются на нём самом — здесь
 * только отцепляемся; `resumeActive` потом подхватит идущие на новом.
 */
export function resetRuns(): void {
  forgetAllRuns();
  stoppedByUser.clear();
}

/** Остановить прогон. Сервер гасит процесс, поток закрывается сам. */
export async function stop(id: string): Promise<void> {
  stoppedByUser.add(id);
  try {
    await api.post(`/chat/${encodeURIComponent(serverKey(id))}/stop`);
  } catch (error) {
    // Сервер не снял процесс: номер нечем проверить, а чужое он не трогает
    // (F-145). Прогон идёт дальше — «остановлено» было бы неправдой, и поток
    // обрывать нельзя: только из него человек увидит, что агент ещё работает.
    if ((error as { code?: unknown } | null)?.code === 'stop_unconfirmed') {
      stoppedByUser.delete(id);
      setRun(id, { error: error instanceof Error ? error.message : String(error) });
      emit();
      return;
    }
    // Прогона уже нет — состояние всё равно приведём к остановленному.
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  setRun(id, { status: 'stopped', stalled: undefined });
  emit();
}

/**
 * Ответить на запрос прав. Карточка исчезнет по событию от сервера.
 *
 * `ok: false` в ответе — решение не дошло: запрос уже закрыт или прогон завершён.
 * Молчать здесь нельзя: карточка при этом выглядит так, будто ответ принят.
 */
export async function decidePermission(
  id: string,
  toolUseId: string,
  behavior: 'allow' | 'deny',
): Promise<void> {
  const result = await api.post<{ ok?: boolean }>(
    `/chat/${encodeURIComponent(serverKey(id))}/permission-decision`,
    { toolUseId, behavior },
  );
  if (result?.ok === false) throw new Error(dict().chat.permissionLost);
}

/**
 * Автоподтверждение безопасных запросов прав — тумблер, щёлкнутый во время
 * прогона. Сервер читает из тела только `enabled`: «правки разрешены» решаются
 * при отправке сообщения и посреди хода не меняются.
 */
export async function setAutoApprove(id: string, enabled: boolean): Promise<void> {
  await api.post(`/chat/${encodeURIComponent(serverKey(id))}/auto-approve`, { enabled });
  setRun(id, { autoApprove: enabled });
  emit();
}

export function enqueue(id: string, message: Omit<QueuedMessage, 'id'>): string {
  const run = getRun(id);
  const queuedId = `q-${Date.now()}-${run.queued.length}`;
  // Метка у каждого: досылка, ответ на которую потерялся в сети, повторяется —
  // и сервер узнаёт повтор уже принятого, а не отдаёт его агенту дважды.
  const clientId = message.clientId ?? newClientId('queued');
  setRun(id, { queued: [...run.queued, { ...message, clientId, id: queuedId }] });
  emit();
  void persistQueue(id);
  return queuedId;
}

export function cancelQueued(id: string, queuedId: string): void {
  const run = getRun(id);
  setRun(id, { queued: run.queued.filter((item) => item.id !== queuedId) });
  emit();
  void persistQueue(id);
}

/**
 * Поднять очередь, сохранённую до перезапуска приложения. Зовётся при открытии
 * разговора: агент ещё занят — дописанное встаёт в очередь и уйдёт по концу
 * хода; уже свободен — уходит сразу. Прежде чем решать, спрашиваем сервер:
 * пока приложение спало, прогон мог начаться, и досылка вслепую упёрлась бы в
 * «занят», потеряв сообщение.
 */
export async function restoreQueue(id: string): Promise<void> {
  const items = await loadQueue(getRun(id).sessionId, id);
  if (items.length === 0) return;
  await resumeActive();
  const key = findRunKey(id, getRun(id).sessionId) ?? id;
  const current = getRun(key);
  const known = new Set(current.queued.map((item) => item.id));
  const fresh = items.filter((item) => !known.has(item.id));
  if (fresh.length === 0) return;
  setRun(key, { queued: [...current.queued, ...fresh] });
  emit();
  if (getRun(key).status === 'running') {
    await persistQueue(key);
    return;
  }
  await flushQueue(key);
}

/**
 * Агент освободился — отправляем первое из дописанного тем же разговором.
 * Не принятое сервером возвращается в голову очереди: отказ («занят», сеть,
 * группа на паузе) не повод потерять написанное. Досылка помечена `automatic`:
 * группу, которую человек поставил на паузу, она не будит (карточка 33).
 */
async function flushQueue(id: string): Promise<void> {
  if (flushing.has(id)) return;
  const run = getRun(id);
  const [next, ...rest] = run.queued;
  if (!next) return;
  flushing.add(id);
  try {
    await sendQueued(id, run, next, rest);
  } finally {
    flushing.delete(id);
  }
}

/** Отправить голову очереди; не принятое возвращается в её начало. */
async function sendQueued(
  id: string,
  run: AgentRun,
  next: QueuedMessage,
  rest: QueuedMessage[],
): Promise<void> {
  setRun(id, { queued: rest });
  emit();
  await persistQueue(id);
  const outcome = await send({
    chatId: id,
    prompt: next.prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    allowEdits: next.allowEdits,
    autoApprove: next.autoApprove,
    model: next.model,
    effort: next.effort,
    files: next.files,
    ...(next.clientId ? { clientId: next.clientId } : {}),
    automatic: true,
  });
  if (outcome.ok) return;
  const after = getRun(id);
  setRun(id, { queued: [next, ...after.queued] });
  emit();
  await persistQueue(id);
}
