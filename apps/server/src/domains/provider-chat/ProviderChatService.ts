import { randomUUID } from 'node:crypto';
import type {
  ProviderChatEvent,
  ProviderChatMessage,
  ProviderChatStatus,
  ProviderChatTransport,
} from '@agentdeck/contracts';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import {
  ProviderChatRun,
  type ProviderChatRunLike,
  type ProviderChatRunOptions,
} from './ProviderChatRun.ts';
import type { PlatformRunRoute } from '../platform/routing.ts';
import { expandCommand, type SupervisorCommand } from '../portability/supervisor/commands.ts';
import { appendMessage, dropMessage, readChat } from './store.ts';
import { composeUserMessage } from './prompt.ts';
import { withChildrenBrief } from '../chat/children-brief.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Живые ответы чужих провайдеров: прогон принадлежит серверу, а не запросу.
 *
 * Та же причина, по которой у Claude есть реестр прогонов: закрытая вкладка,
 * обрыв связи или переход на другую страницу не должны убивать ответ на
 * полуслове. Здесь это ещё важнее — у одноразового CLI нет никакого «продолжить
 * с того места», второй попытки просто не будет.
 *
 * Накопленный текст живёт в `partial`, поэтому вернувшаяся вкладка догоняет
 * пропущенное одним запросом состояния, без хитрой нумерации событий: ответ —
 * это один растущий кусок текста, а не поток разнородных шагов.
 */

export interface ProviderChatSubscriber {
  send: (event: ProviderChatEvent) => void;
  close: () => void;
}

/** Что надзиратель получает от прогона, чтобы собрать его набор скриптов (П6.2). */
export interface SupervisorRunContext {
  readonly providerId: string;
  readonly chatId: string;
  readonly appDataDir: string;
  /** Рабочий каталог разговора; пусто — каталог сервера. */
  readonly workdir?: string;
  /** Разговор только что заведён — в нём это первая реплика человека. */
  readonly starting: boolean;
}

/** Надзиратель одного прогона — ровно то, что принимает `ProviderChatRun`. */
export type SupervisorSetup = NonNullable<ProviderChatRunOptions['supervisor']>;

/** Сколько держать завершённый прогон — окно на переподключение вкладки. */
const GRACE_MS = 60_000;

interface LiveRun {
  providerId: string;
  appDataDir: string;
  run: ProviderChatRunLike;
  partial: string;
  transport?: ProviderChatTransport;
  subscribers: Set<ProviderChatSubscriber>;
  isRunning: boolean;
  /** Когда прогон начался: по нему считается время ответа (Т1 партии чужих CLI). */
  startedAt: number;
  /**
   * Ответ сняли кнопкой. Записанным он остаётся (сказанное — сказано), но
   * ЗАКОНЧЕННЫМ не считается: снятая на полуслове работа не повод заводить по
   * ней следующее звено конвейера.
   */
  stopped?: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Прогон, который не поднимает процесс: его старт — сразу отказ с этим текстом. */
function refusedRun(refusal: string): ProviderChatRunLike {
  return { start: () => Promise.reject(new Error(refusal)), stop: () => {} };
}

/** След остановленного прогона, который не успел ответить ни словом. */
const STOPPED_TEXT = serverText('chat-run-stopped-no-answer');

/** Разговор, у которого закончился ответ, — то, что видит слушатель. */
export interface ProviderChatFinished {
  providerId: string;
  appDataDir: string;
  chatId: string;
  /** Ответ дошёл до конца сам: не ошибка и не остановка человеком. */
  ok: boolean;
  /** Текст ответа целиком. */
  text: string;
  /** Чем кончился упавший ход — по нему надзор решает, временный ли сбой (Д10). */
  error?: string;
  /** Ход остановил человек: это не сбой, и повторять его нельзя. */
  stopped?: boolean;
  /**
   * Когда прогон начался. Нужен продолжению в чистой сессии (Т7): файл-опора
   * обязан быть свежее старта, иначе новая сессия читала бы вчерашнее.
   */
  startedAt: number;
}

/**
 * Что нужно прогону сверх самого разговора (подменяется в тестах). Модель и
 * глубина сюда не входят: они принадлежат РАЗГОВОРУ и читаются из его шапки —
 * иначе второе сообщение в тот же чат уехало бы без назначения (см. Т12).
 */
export type ProviderChatRunDeps = Omit<
  ProviderChatRunOptions,
  | 'history'
  | 'chatId'
  | 'appDataDir'
  | 'workdir'
  | 'model'
  | 'effort'
  | 'platformEnv'
  | 'supervisor'
> & {
  /**
   * Слэш-команды панели (П3.4). Разворачиваются ЗДЕСЬ, а не в прогоне: тело
   * команды обязано попасть в переписку, а переписку ведёт служба. В опции
   * прогона это поле не уходит — ему там нечего делать.
   */
  commands?: readonly SupervisorCommand[];
};

export interface SendOutcome {
  ok: boolean;
  /** Записанная реплика пользователя (для мгновенного показа). */
  message?: ProviderChatMessage;
  /** Машинная причина отказа: разговора нет либо ответ уже идёт. */
  reason?: 'not_found' | 'already_running';
}

export class ProviderChatService {
  private runs = new Map<string, LiveRun>();
  private readonly createRun: () => ProviderChatRunLike;
  private onFinished?: (finished: ProviderChatFinished) => void;

  /**
   * Фабрика прогона присваивается вручную: сервер исполняет TypeScript без
   * сборки, а `parameter properties` в этом режиме не поддерживаются.
   */
  constructor(createRun: () => ProviderChatRunLike = () => new ProviderChatRun()) {
    this.createRun = createRun;
  }

  /**
   * Кому сообщать, что ответ закончился. Тем же приёмом, что у реестра прогонов
   * Claude: сервис знает только «ответ дописан», а решение о следующем звене
   * конвейера принимает домен и собирает bootstrap (`domains/provider-chat/cascade.ts`).
   * Слушателя нет — всё ведёт себя как до конвейера.
   */
  setFinishedListener(listener: (finished: ProviderChatFinished) => void): void {
    this.onFinished = listener;
  }

  private onStarted?: (providerId: string, chatId: string) => void;

  /** Кому сообщать, что ответ начался: группа снова «работает» (Д3). */
  setStartListener(listener: (providerId: string, chatId: string) => void): void {
    this.onStarted = listener;
  }

  /**
   * Маршрут контура для чата чужого CLI (Т3): по потребителю `foreign:<cli>` —
   * переменные окружения ОДНОГО запуска.
   *
   * Тем же приёмом, что у реестра Claude, и по той же причине: служба знает,
   * КАКОЙ CLI она поднимает, но про контуры, шлюз и ключи не знает ничего.
   * Спрашивается на КАЖДОМ сообщении — снятая галочка обязана действовать со
   * следующего запуска, а не с перезапуска панели. Слушателя нет — чат ходит
   * своим провайдером, как до контуров.
   */
  setPlatformRouting(
    resolve: (consumer: string, asked: string, runTag: string) => PlatformRunRoute,
  ): void {
    this.platformRouting = resolve;
  }

  private platformRouting?: (consumer: string, asked: string, runTag: string) => PlatformRunRoute;

  /**
   * Сжимал ли контур историю в прогоне с этой меткой (`context-managed`). Метку
   * служба выдаёт сама на каждое сообщение, и она уезжает в адрес шлюза только
   * этому прогону, — поэтому соседний чат через тот же контур чужую подпись не
   * получит, в отличие от счёта по окну времени.
   */
  setContourSummarized(check: (runTag: string) => boolean): void {
    this.contourSummarized = check;
  }

  private contourSummarized?: (runTag: string) => boolean;

  /**
   * Сколько вызовов инструментов агента видел шлюз контура с момента `sinceMs`
   * (развилка 5). `undefined` — запросов через шлюз не было вовсе, и тогда
   * молчать честнее, чем сказать «ноль вызовов».
   *
   * Счёт по журналу, а не по прогону: два чата через один контур в одно время
   * сложатся. Цена — пропущенная подсказка, не ложная: сумма только больше.
   */
  setContourToolCalls(count: (sinceMs: number) => number | undefined): void {
    this.contourToolCalls = count;
  }

  private contourToolCalls?: (sinceMs: number) => number | undefined;

  /**
   * Набор скриптов, которые панель отыграет вокруг прогона (П6.2).
   *
   * Тем же приёмом, что у маршрута контура, и по той же причине: служба знает,
   * КАКОЙ разговор она ведёт, но про калитку, группы и каталоги панели не знает
   * ничего. Спрашивается на КАЖДОМ сообщении — выключенная калитка обязана
   * перестать действовать со следующего запроса, а не с перезапуска панели; ровно
   * поэтому поля нет и в `ProviderChatRunDeps`: отложенный запуск дерева унёс бы
   * с собой набор, собранный при прежних настройках.
   *
   * Слушателя нет — надзиратель молчит, и прогон идёт как до него.
   */
  setSupervisor(resolve: (run: SupervisorRunContext) => SupervisorSetup | undefined): void {
    this.supervisor = resolve;
  }

  private supervisor?: (run: SupervisorRunContext) => SupervisorSetup | undefined;

  /**
   * Сводка детей разделения для хода родителя (Д6) — как у Claude, но в
   * переписку она не пишется: историю модели собирает панель, и сводка едет
   * только в последней реплике ЭТОГО хода. В переписке — то, что сказал человек.
   */
  setChildrenBrief(resolve: (providerId: string, chatId: string) => string | undefined): void {
    this.childrenBriefOf = resolve;
  }

  private childrenBriefOf?: (providerId: string, chatId: string) => string | undefined;

  /** Задать вопрос: реплика пользователя пишется сразу, ответ идёт потоком. */
  send(
    appDataDir: string,
    providerId: string,
    chatId: string,
    input: { text: string; attachments?: string[] },
    deps: ProviderChatRunDeps,
  ): SendOutcome {
    const existing = this.runs.get(chatId);
    if (existing?.isRunning) return { ok: false, reason: 'already_running' };

    const chat = readChat(appDataDir, providerId, chatId);
    if (!chat) return { ok: false, reason: 'not_found' };

    // Команда разворачивается ДО записи реплики, и в переписку ложится её ТЕЛО:
    // человек видит ровно тот текст, который уехал модели, и по нему же читает
    // ответ. Записать «/review», а отправить две страницы значило бы спрятать
    // половину разговора от того, кто его ведёт.
    const { commands, ...runDeps } = deps;
    const expanded = commands ? expandCommand(input.text, commands) : undefined;
    const content = composeUserMessage(expanded?.text ?? input.text, input.attachments);
    const message = appendMessage(appDataDir, providerId, chatId, { role: 'user', content });
    if (!message) return { ok: false, reason: 'not_found' };

    const live: LiveRun = {
      providerId,
      appDataDir,
      run: this.createRun(),
      partial: '',
      subscribers: existing?.subscribers ?? new Set(),
      isRunning: true,
      startedAt: Date.now(),
    };
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
    this.runs.set(chatId, live);
    try {
      this.onStarted?.(providerId, chatId);
    } catch {
      // Слушатель не должен ронять отправку, реплика уже записана.
    }

    const brief = this.childrenBriefOf?.(providerId, chatId);
    const history = [
      ...chat.messages,
      brief ? { ...message, content: withChildrenBrief(message.content, brief) } : message,
    ];
    // Маршрут решается ЗДЕСЬ, на каждом сообщении, и в опции прогона приходит
    // только отсюда: у `ProviderChatRunDeps` этого поля нет намеренно — иначе
    // адрес контура протащил бы в новый запуск отложенный вызов конвейера,
    // собранный при прежней галочке. Пустой объект — «не через контур».
    const runTag = randomUUID();
    const route = this.platformRouting?.(
      foreignConsumerId(providerId),
      chat.model ?? '',
      runTag,
    ) ?? {
      env: {},
    };
    // Подобранная модель живёт в шапке разговора и действует на КАЖДОЕ сообщение
    // в нём, а не только на первое. Через контур её место занимает модель
    // контура (Т6): имя вендора он не знает, а усилия не принимает вовсе — и то
    // и другое решено маршрутом, а не здесь.
    const model = route.model?.model || chat.model || '';
    const effort = route.effort === false ? '' : (chat.effort ?? '');
    // Отказ обязательного контура — тем же путём, что и упавший прогон: процесс
    // не поднимается, а в переписке остаётся причина.
    if (route.refusal) live.run = refusedRun(route.refusal);

    // Набор скриптов надзирателя решается ЗДЕСЬ и на каждом сообщении — по тем же
    // причинам, что и маршрут контура выше. `starting` считается по переписке ДО
    // новой реплики: `SessionStart` принадлежит первому вопросу разговора, а не
    // каждому.
    const supervisor = this.supervisor?.({
      providerId,
      chatId,
      appDataDir,
      ...(chat.workdir ? { workdir: chat.workdir } : {}),
      starting: chat.messages.length === 0,
    });

    void live.run
      .start(
        {
          ...runDeps,
          history,
          chatId,
          appDataDir,
          platformEnv: route.env,
          ...(supervisor ? { supervisor } : {}),
          ...(chat.workdir ? { workdir: chat.workdir } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
        (event) => {
          if (event.type === 'delta') {
            live.partial += event.text;
            this.broadcast(live, { type: 'delta', text: event.text });
            return;
          }

          if (event.type === 'done') {
            live.transport = event.transport;
            // Остановленный прогон, не успевший сказать НИЧЕГО, — оборванная
            // работа, а не пустой ответ: пустой пузырь в ленте читается как
            // «CLI ответил молчанием», а при паузе дерева таких пузырей копится
            // по одному на каждую остановку. Сказанное до остановки, наоборот,
            // остаётся ответом — им разговор и продолжается.
            const cut = Boolean(live.stopped) && event.reply.trim() === '';
            const routed = Object.keys(route.env).length > 0 && !route.refusal;
            const toolCalls = routed && !cut ? this.contourToolCalls?.(live.startedAt) : undefined;
            const summarized = routed && !cut && this.contourSummarized?.(runTag) === true;
            const stored = appendMessage(appDataDir, providerId, chatId, {
              role: 'assistant',
              content: cut ? STOPPED_TEXT : event.reply,
              ...(cut ? { failed: true } : {}),
              transport: event.transport,
              durationMs: Date.now() - live.startedAt,
              ...(toolCalls === undefined ? {} : { contourToolCalls: toolCalls }),
              ...(summarized ? { contextSummarized: true } : {}),
            });
            this.finish(chatId, live, {
              type: 'done',
              ...(stored ? { message: stored } : {}),
            });
            return;
          }

          // Отказ калитки ДО запуска CLI снимает реплику из переписки: она
          // никуда не уехала. Оставленная, она уедет чужому CLI СЛЕДУЮЩИМ
          // сообщением внутри `history` — калитка смотрит только последнюю
          // реплику и второй раз эту не увидит, то есть запрет обходился бы
          // простым «напиши что-нибудь ещё». Признак «прогон не начинался» —
          // наблюдаемый, а не додуманный: по контракту `hook_blocked` значит
          // ровно это, и ни `delta`, ни `done` до него не приходило.
          if (event.reason === 'hook_blocked' && live.partial === '' && !live.transport) {
            dropMessage(appDataDir, providerId, chatId, message.id);
          }

          // Провалившийся прогон время тоже несёт: «сколько мы ждали зря» —
          // такой же вопрос человека, как «сколько шла работа».
          appendMessage(appDataDir, providerId, chatId, {
            role: 'assistant',
            content: event.error,
            failed: true,
            durationMs: Date.now() - live.startedAt,
          });
          this.finish(chatId, live, { type: 'error', error: event.error, reason: event.reason });
        },
      )
      .catch((error: unknown) => {
        // Прогон упал мимо собственной обработки ошибок. След в переписке нужен
        // тот же самый: иначе вопрос остался бы без ответа и без объяснения.
        const text = error instanceof Error ? error.message : String(error);
        appendMessage(appDataDir, providerId, chatId, {
          role: 'assistant',
          content: text,
          failed: true,
          durationMs: Date.now() - live.startedAt,
        });
        this.finish(chatId, live, { type: 'error', error: text, reason: 'cli_error' });
      });

    return { ok: true, message };
  }

  /**
   * Подключиться к идущему ответу. Возвращает отписку.
   *
   * Подключение к тому, что уже кончилось, закрывается сразу: держать открытым
   * пустой поток значит показывать «ответ идёт» там, где ответ давно записан, —
   * а вкладка ждала бы его до перезагрузки страницы.
   */
  subscribe(chatId: string, subscriber: ProviderChatSubscriber): () => void {
    const live = this.runs.get(chatId);
    if (!live?.isRunning) {
      subscriber.close();
      return () => {};
    }

    live.subscribers.add(subscriber);
    return () => live.subscribers.delete(subscriber);
  }

  /** Состояние разговора: идёт ли ответ и что уже напечатано. */
  status(chatId: string): ProviderChatStatus {
    const live = this.runs.get(chatId);
    return {
      chatId,
      isRunning: Boolean(live?.isRunning),
      partial: live?.partial ?? '',
      ...(live?.transport ? { transport: live.transport } : {}),
    };
  }

  /**
   * Остановить ответ. Сказанное до остановки остаётся ответом и попадает в
   * переписку: молча выбрасывать уже полученный текст было бы враньём про то,
   * что модель сделала.
   */
  stop(chatId: string): boolean {
    const live = this.runs.get(chatId);
    if (!live?.isRunning) return false;

    live.stopped = true;
    live.run.stop();
    this.broadcast(live, { type: 'stopped' });
    return true;
  }

  /**
   * Человек нажал «Стоп» (журнал 89c у Claude, открытый вопрос WP9e). Слушатель —
   * конвейер разделения: группа встаёт на паузу, а не «сбоем», и место в очереди
   * отдаёт. Остановка панелью (удаление чата, выход) сюда не идёт.
   */
  private onHumanStop?: (providerId: string, chatId: string) => void;

  setHumanStopListener(listener: (providerId: string, chatId: string) => void): void {
    this.onHumanStop = listener;
  }

  /** «Стоп» человека: слушатель узнаёт ДО остановки — конец хода застанет паузу. */
  stopByHuman(chatId: string): boolean {
    const live = this.runs.get(chatId);
    if (!live?.isRunning) return false;
    try {
      this.onHumanStop?.(live.providerId, chatId);
    } catch {
      // Слушатель чужой: его сбой не имеет права сорвать остановку.
    }
    return this.stop(chatId);
  }

  /** Погасить всё разом — при выходе сервера. */
  stopAll(): void {
    for (const [chatId] of this.runs) this.stop(chatId);
  }

  private broadcast(live: LiveRun, event: ProviderChatEvent): void {
    for (const subscriber of live.subscribers) subscriber.send(event);
  }

  private finish(chatId: string, live: LiveRun, event: ProviderChatEvent): void {
    if (!live.isRunning) return;
    live.isRunning = false;
    this.broadcast(live, event);
    for (const subscriber of live.subscribers) subscriber.close();
    live.subscribers.clear();

    live.cleanupTimer = setTimeout(() => {
      if (this.runs.get(chatId) === live) this.runs.delete(chatId);
    }, GRACE_MS);
    live.cleanupTimer.unref?.();

    if (!this.onFinished) return;
    try {
      this.onFinished({
        providerId: live.providerId,
        appDataDir: live.appDataDir,
        chatId,
        startedAt: live.startedAt,
        ok: event.type === 'done' && !live.stopped,
        text: event.type === 'done' ? (event.message?.content ?? live.partial) : '',
        ...(event.type === 'error' ? { error: event.error } : {}),
        ...(live.stopped ? { stopped: true } : {}),
      });
    } catch {
      // Слушатель зовётся ИЗ колбэка прогона: брошенное отсюда исключение
      // вернулось бы в него, а оттуда — в `.catch` запуска, который дописал бы в
      // переписку вторую реплику об ошибке. Ответ уже записан и разослан; о
      // своих бедах слушатель сообщает сам (`onError` планировщика).
    }
  }
}
