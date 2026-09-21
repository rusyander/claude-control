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
import { appendMessage, readChat } from './store.ts';
import { composeUserMessage } from './prompt.ts';
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
  'history' | 'chatId' | 'appDataDir' | 'workdir' | 'model' | 'effort' | 'platformEnv'
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

    const history = [...chat.messages, message];
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

    void live.run
      .start(
        {
          ...runDeps,
          history,
          chatId,
          appDataDir,
          platformEnv: route.env,
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
      });
    } catch {
      // Слушатель зовётся ИЗ колбэка прогона: брошенное отсюда исключение
      // вернулось бы в него, а оттуда — в `.catch` запуска, который дописал бы в
      // переписку вторую реплику об ошибке. Ответ уже записан и разослан; о
      // своих бедах слушатель сообщает сам (`onError` планировщика).
    }
  }
}
