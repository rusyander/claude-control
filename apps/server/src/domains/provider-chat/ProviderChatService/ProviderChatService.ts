import { randomUUID } from 'node:crypto';
import type {
  ProviderChatEvent,
  ProviderChatMessage,
  ProviderChatPermission,
  ProviderChatQueued,
  ProviderChatStatus,
  ProviderChatTransport,
} from '@agentdeck/contracts';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import {
  ProviderChatRun,
  type ProviderChatRunLike,
  type ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';
import type { PlatformRunRoute } from '../../platform/routing/routing.ts';
import { expandCommand, type SupervisorCommand } from '../../portability/supervisor/commands.ts';
import { appendMessage, dropMessage, readChat } from '../store/store.ts';
import { composeUserMessage } from '../prompt/prompt.ts';
import { withChildrenBrief } from '../../chat/children-brief/children-brief.ts';
import type { RunNotice } from '../../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { ForeignSendQueue } from '../queue.ts';
import type { GroupLayerHook } from '../../groups/run-layer/run-layer.types.ts';
import type { LivePermissionAsk, LivePermissionPolicy } from '../live/types.ts';

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
  /**
   * Хуки групп прогона, которые CLI сам не отыграет (Codex: слой в его файлы не
   * пишет) — надзиратель играет их рядом с собственными записями панели.
   */
  readonly layerHooks?: readonly GroupLayerHook[];
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
  /** Ход начат в серверном режиме CLI: новое сообщение уйдёт в него же (В1). */
  steerable?: boolean;
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
  /** Опции отправки хода — ими уходит сообщение очереди, пережившее перезапуск. */
  deps: ProviderChatRunDeps;
  /**
   * Просьбы CLI о разрешении, ждущие человека. Своё хранилище чата чужого CLI:
   * брокер прав Claude привязан к его реестру прогонов, и чужой ход туда не
   * пишется (неизменное правило 1). Живёт ровно ход: конец и «Стоп» отвечают
   * отказом на всё, что ещё ждёт.
   */
  asks: Map<string, PendingAsk>;
}

interface PendingAsk {
  view: ProviderChatPermission;
  resolve: (decision: 'allow' | 'deny') => void;
}

/** Прогон, который не поднимает процесс: его старт — сразу отказ с этим текстом. */
function refusedRun(refusal: string): ProviderChatRunLike {
  return { start: () => Promise.reject(new Error(refusal)), stop: () => {} };
}

/**
 * Строка о каталоге — хвостом реплики, одной строкой и в своей обёртке. Команда
 * CLI (`/compact`) остаётся как есть: хвост превратил бы её аргументы в текст.
 *
 * Реплика в одну строку остаётся одной строкой (многострочный запрос через
 * `.cmd` Windows не проходит). Многострочная — это вложения: последняя строка
 * там путь файла, и строка через пробел приклеилась бы к нему, — ей своя строка.
 */
export function withWorkspaceNote(content: string, note: string): string {
  const line = note.replace(/[\r\n]+/g, ' ').trim();
  if (!line || content.trimStart().startsWith('/')) return content;
  const joint = /[\r\n]/.test(content) ? '\n' : ' ';
  return `${content}${joint}<agentdeck-workspace>${line}</agentdeck-workspace>`;
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
  | 'permission'
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

/**
 * Группы на этот прогон чужого CLI (`bootstrap/group-activation-wiring/group-activation-wiring.ts`):
 * окружение слоя, заметка для ленты и — редко — отказ прогону целиком (слой
 * не помещается, обрезать молча нельзя).
 */
export interface GroupRunActivation {
  env?: Record<string, string>;
  /** Хуки группы для надзирателя прогона (`SupervisorRunContext.layerHooks`). */
  hooks?: readonly GroupLayerHook[];
  /** Заметка с отпечатком: одна строка в ленту на (разговор, отпечаток). */
  notice?: { digest: string; text: string };
  refusal?: string;
}

/** Группы к старту ответа: слой на прогон вместо тумблера каталогов Claude. */
export type GroupActivation = (
  providerId: string,
  chatId: string,
  workdir?: string,
) => GroupRunActivation | undefined;

export class ProviderChatService {
  private runs = new Map<string, LiveRun>();
  private readonly queue = new ForeignSendQueue<ProviderChatRunDeps>();
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
   * конвейера принимает домен и собирает bootstrap (`domains/provider-chat/cascade/cascade.ts`).
   * Слушателя нет — всё ведёт себя как до конвейера.
   */
  setFinishedListener(listener: (finished: ProviderChatFinished) => void): void {
    this.onFinished = listener;
  }

  private onStarted?: (providerId: string, chatId: string) => void;

  private groupActivationOf?: GroupActivation;

  /**
   * Выбранная группа разговора — включить к началу ответа, тем же вопросом,
   * что и реестр Claude (`setGroupActivation`): одна точка на все отправки.
   * Ответ — окружение прогона, если группа едет слоем (Qwen: файл системных
   * настроек), а не тумблером каталогов.
   */
  setGroupActivation(activate: GroupActivation): void {
    this.groupActivationOf = activate;
  }

  /** Отпечаток последней заметки о группах по разговору — повтор не пишется. */
  private readonly groupNoticeDigest = new Map<string, string>();

  /**
   * Заметка о группах прогона — одна на (разговор, отпечаток слоя): на каждом
   * сообщении одна и та же строка засыпала бы ленту. После перезапуска панели
   * память пуста, поэтому сверка идёт ещё и с ПОСЛЕДНЕЙ такой заметкой в
   * переписке: тот же текст — говорить нечего.
   */
  private noteGroupLayer(
    appDataDir: string,
    providerId: string,
    chatId: string,
    notice: { digest: string; text: string },
  ): void {
    const key = foreignChatKey(providerId, chatId);
    if (this.groupNoticeDigest.get(key) === notice.digest) return;
    this.groupNoticeDigest.set(key, notice.digest);
    const head = serverText('group-layer-notice', { cli: '\u0001', groups: '' }).split(
      '\u0001',
    )[0]!;
    const last = readChat(appDataDir, providerId, chatId)
      ?.messages.filter((item) => item.role === 'notice' && item.content.startsWith(head))
      .at(-1);
    if (last?.content === notice.text) return;
    appendMessage(appDataDir, providerId, chatId, { role: 'notice', content: notice.text });
  }

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

  /**
   * Строка о каталоге разговора (тесты проекта, папка e2e) — той же функцией,
   * что у реестра Claude (`ChatRunRegistry.setWorkspaceNote`). У чужого CLI
   * системной строки нет, и едет она хвостом ПОСЛЕДНЕЙ реплики этого хода, в
   * ту же строку: отдельная реплика (`systemPrefix`) сделала бы запрос
   * многострочным, а многострочный запрос через `.cmd`-обёртку Windows не
   * пропускает (`cli-spawn.ts`) — первый же вопрос такого CLI упал бы. В
   * переписку она не пишется и спрашивается на КАЖДОМ сообщении; осечка
   * решателя отправку не срывает.
   */
  setWorkspaceNote(resolve: (cwd: string) => string | undefined): void {
    this.workspaceNoteOf = resolve;
  }

  private workspaceNoteOf?: (cwd: string) => string | undefined;

  private workspaceNote(workdir: string | undefined): string {
    if (!workdir) return '';
    try {
      return this.workspaceNoteOf?.(workdir) ?? '';
    } catch {
      return '';
    }
  }

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
      deps,
      asks: new Map(),
    };
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
    this.runs.set(chatId, live);
    try {
      this.onStarted?.(providerId, chatId);
    } catch {
      // Слушатель не должен ронять отправку, реплика уже записана.
    }
    let groups: GroupRunActivation | undefined;
    try {
      groups = this.groupActivationOf?.(providerId, chatId, chat.workdir);
    } catch {
      // Группа не главнее разговора: осечка включения отправку не срывает.
    }
    const groupEnv = groups?.env;
    if (groups?.notice) this.noteGroupLayer(appDataDir, providerId, chatId, groups.notice);

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
    else if (groups?.refusal) live.run = refusedRun(groups.refusal);

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
      ...(groups?.hooks?.length ? { layerHooks: groups.hooks } : {}),
    });

    // «Разрешить правки» — из шапки разговора на КАЖДОМ сообщении: переключатель,
    // сдвинутый между ходами, действует со следующего. Нет поля (разговор старше
    // переключателя) — вопрос человеку, а не молчаливое «да» и не отказ всем.
    const permission: LivePermissionPolicy = {
      allowEdits: chat.allowEdits === true,
      ask: (request) => this.askHuman(chatId, live, request, chat.workdir),
    };

    const note = this.workspaceNote(chat.workdir);
    const last = history.at(-1);
    if (note && last) {
      history[history.length - 1] = { ...last, content: withWorkspaceNote(last.content, note) };
    }

    void live.run
      .start(
        {
          ...runDeps,
          history,
          chatId,
          appDataDir,
          // Набор панели (В2) — у Qwen Code свой `QWEN_HOME` в режиме «Наши».
          // Слой группы — последним: его файл настроек решён для ЭТОГО разговора.
          platformEnv: { ...route.env, ...route.kit?.env, ...groupEnv },
          ...(supervisor ? { supervisor } : {}),
          ...(chat.workdir ? { workdir: chat.workdir } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          permission,
        },
        (event) => {
          if (event.type === 'delta') {
            live.partial += event.text;
            this.broadcast(live, { type: 'delta', text: event.text });
            return;
          }

          if (event.type === 'steerable') {
            live.steerable = true;
            this.broadcast(live, { type: 'steerable' });
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

  /** Состояние разговора: идёт ли ответ, что уже напечатано и что ждёт очереди. */
  status(chatId: string): ProviderChatStatus {
    const live = this.runs.get(chatId);
    const queued = this.queue.list(chatId);
    const isRunning = Boolean(live?.isRunning);
    return {
      chatId,
      isRunning,
      partial: live?.partial ?? '',
      ...(live?.transport ? { transport: live.transport } : {}),
      ...(isRunning && live?.steerable && !live.stopped ? { steerable: true } : {}),
      ...(queued.length > 0 ? { queued } : {}),
      // Очередь без идущего хода сама не уйдёт: ход остановили или панель
      // перезапускалась (Ф13). Человек видит «ждёт отправки» и кнопку.
      ...(queued.length > 0 && !isRunning ? { queueHeld: true } : {}),
      ...(isRunning && live && live.asks.size > 0 ? { permissions: pendingViews(live) } : {}),
    };
  }

  /**
   * Дождаться перемены, о которой стоит сказать человеку: ход кончился (или его
   * и не было) либо сменились просьбы о разрешении — не дольше `ms`. Телефону в
   * фоне таймеры не служат (Android усыпляет их), а ответ сети будит его и там:
   * так он узнаёт о конце хода без опроса по часам.
   */
  waitForChange(chatId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = (): void => {};
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, ms);
      unsubscribe = this.subscribe(chatId, {
        send: (event) => {
          if (event.type === 'permissions') done();
        },
        close: done,
      });
      if (settled) unsubscribe();
    });
  }

  /**
   * Ответ человека на просьбу CLI о разрешении. `false` — просьбы уже нет (ход
   * кончился, ответили в другой вкладке): решать больше нечего.
   */
  answerPermission(chatId: string, askId: string, decision: 'allow' | 'deny'): boolean {
    const live = this.runs.get(chatId);
    const pending = live?.asks.get(askId);
    if (!live || !pending) return false;
    live.asks.delete(askId);
    this.broadcast(live, { type: 'permissions', permissions: pendingViews(live) });
    pending.resolve(decision);
    return true;
  }

  /**
   * Вопрос человеку от живого хода: карточка в ленте (событие `permissions` и
   * статус для вернувшейся вкладки) и уведомление на телефон тем же видом
   * `permission`, что у Claude. Ход кончился или остановлен — отказ сразу.
   */
  private askHuman(
    chatId: string,
    live: LiveRun,
    request: LivePermissionAsk,
    workdir: string | undefined,
  ): Promise<'allow' | 'deny'> {
    if (!live.isRunning || live.stopped) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      live.asks.set(id, {
        view: {
          id,
          ...(request.tool ? { tool: request.tool } : {}),
          ...(request.title ? { title: request.title } : {}),
          at: new Date().toISOString(),
        },
        resolve,
      });
      this.broadcast(live, { type: 'permissions', permissions: pendingViews(live) });
      try {
        this.notify?.({
          kind: 'permission',
          chatId: foreignChatKey(live.providerId, chatId),
          ...(workdir ? { projectPath: workdir } : {}),
          ...(request.tool ? { toolName: request.tool } : {}),
        });
      } catch {
        // Уведомление — не часть хода: его сбой вопрос не снимает.
      }
    });
  }

  /** Подтянуть очередь разговора с диска — после перезапуска панели (Ф13). */
  hydrate(appDataDir: string, providerId: string, chatId: string): void {
    this.queue.hydrate(appDataDir, providerId, chatId);
  }

  /**
   * «Отправить» у ждущей очереди (Ф13): сообщение вынимается и уходит обычной
   * отправкой с опциями, собранными маршрутом сейчас. Ответ идёт — отказ, и
   * сообщение остаётся на месте: его отпустит конец этого хода.
   */
  sendQueued(
    appDataDir: string,
    providerId: string,
    chatId: string,
    queuedId: string,
    deps: ProviderChatRunDeps,
  ): SendOutcome & { missing?: true } {
    this.queue.hydrate(appDataDir, providerId, chatId);
    if (this.runs.get(chatId)?.isRunning) return { ok: false, reason: 'already_running' };
    const item = this.queue.take(chatId, queuedId);
    if (!item) return { ok: false, missing: true };
    const outcome = this.send(
      appDataDir,
      providerId,
      chatId,
      { text: item.text, ...(item.attachments ? { attachments: item.attachments } : {}) },
      deps,
    );
    if (!outcome.ok && outcome.reason === 'already_running') this.queue.unshift(chatId, item);
    return outcome;
  }

  /**
   * Сообщение занятому разговору — в очередь (`queue.ts`), по концу ответа оно
   * уйдёт само. `undefined` — ответа не идёт, и отправлять надо обычным путём:
   * очередь без хода, который её отпустит, ждала бы вечно.
   */
  enqueue(
    appDataDir: string,
    providerId: string,
    chatId: string,
    input: { text: string; attachments?: string[] },
    deps: ProviderChatRunDeps,
  ): ProviderChatQueued | undefined {
    if (!this.runs.get(chatId)?.isRunning) return undefined;
    return this.queue.add(chatId, {
      providerId,
      appDataDir,
      text: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      deps,
    });
  }

  /**
   * Сообщение посреди ответа — в ТОТ ЖЕ ход, если у пути есть вход (В1: Codex,
   * Qwen Code, OpenCode). Реплика пишется в переписку только после того, как ход
   * её принял: принятая, она часть этого хода, и ответ, идущий следом, отвечает и
   * на неё. `undefined` — входа нет или ход отказал (кончился, ещё не начат):
   * вызывающий ставит сообщение в очередь, как раньше.
   *
   * Команды разворачиваются тем же `expandCommand`, что у обычной отправки:
   * человек видит в переписке ровно то, что уехало модели.
   */
  async steer(
    appDataDir: string,
    providerId: string,
    chatId: string,
    input: { text: string; attachments?: string[] },
    deps: ProviderChatRunDeps,
  ): Promise<ProviderChatMessage | undefined> {
    const live = this.runs.get(chatId);
    if (!live?.isRunning || live.stopped || !live.run.steer) return undefined;
    const expanded = deps.commands ? expandCommand(input.text, deps.commands) : undefined;
    const content = composeUserMessage(expanded?.text ?? input.text, input.attachments);
    // Ход упал на полуслове — сообщение не принято, оно уйдёт очередью.
    const accepted = await live.run.steer(content).catch(() => false);
    if (!accepted) return undefined;
    // Ход принял сообщение — оно уже в работе, даже если ход тут же кончился:
    // в переписке оно обязано остаться, иначе ответ отвечал бы на невидимое.
    const message = appendMessage(appDataDir, providerId, chatId, {
      role: 'user',
      content,
      steered: true,
    });
    if (message) this.broadcast(live, { type: 'steered', message });
    return message;
  }

  /** Убрать сообщение из очереди, пока оно не ушло. */
  cancelQueued(chatId: string, queuedId: string): boolean {
    return this.queue.cancel(chatId, queuedId);
  }

  /** Разговор удалён: его очереди больше некуда уходить. */
  discard(chatId: string): void {
    this.stop(chatId);
    this.queue.clear(chatId);
  }

  /**
   * Конец ответа — отпустить следующее сообщение очереди, по одному: второе
   * дождётся конца хода, который сейчас начнётся. Разговор успел занять кто-то
   * другой (звено конвейера из слушателя конца) — сообщение возвращается в
   * начало и уйдёт по концу ТОГО хода; разговора больше нет — очередь снимается.
   */
  private drainQueue(chatId: string, fallback: ProviderChatRunDeps): void {
    const next = this.queue.shift(chatId);
    if (!next) return;
    let outcome: SendOutcome;
    try {
      outcome = this.send(
        next.appDataDir,
        next.providerId,
        chatId,
        { text: next.text, ...(next.attachments ? { attachments: next.attachments } : {}) },
        // Сообщение с диска (пережило перезапуск) — опциями хода, который его отпускает.
        next.deps ?? fallback,
      );
    } catch {
      // Досылка идёт из колбэка прогона: исключение вернулось бы в него и
      // дописало бы в переписку чужую ошибку. Сообщение остаётся первым.
      this.queue.unshift(chatId, next);
      return;
    }
    if (outcome.ok) return;
    if (outcome.reason === 'already_running') this.queue.unshift(chatId, next);
    else this.queue.clear(chatId);
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
    // Ждущие вопросы — отказом ДО остановки: ход, который снимают, не должен
    // успеть получить «да», которого человек не давал.
    denyPending(live);
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

  /**
   * Уведомления о конце хода — тот же приём, что `ChatRunRegistry.setNotifier`:
   * служба знает только «ход кончился так-то», а куда и как сообщать, собирает
   * bootstrap. Ключ чата — с приставкой провайдера (`codex:<id>`).
   */
  private notify?: (notice: RunNotice) => void;

  setNotifier(notify: (notice: RunNotice) => void): void {
    this.notify = notify;
  }

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
    denyPending(live);
    this.broadcast(live, event);
    for (const subscriber of live.subscribers) subscriber.close();
    live.subscribers.clear();

    live.cleanupTimer = setTimeout(() => {
      if (this.runs.get(chatId) === live) this.runs.delete(chatId);
    }, GRACE_MS);
    live.cleanupTimer.unref?.();

    if (this.onFinished) {
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

    // Телефон и Telegram — тем же отправителем, что у прогонов Claude. Снятый
    // ход молчит: его снял человек у панели либо сама панель (выход, удаление
    // чата), и «прогон упал» на каждый такой ход был бы враньём.
    if (this.notify && !live.stopped) {
      try {
        const workdir = readChat(live.appDataDir, live.providerId, chatId)?.workdir;
        this.notify({
          kind: event.type === 'done' ? 'done' : 'error',
          chatId: foreignChatKey(live.providerId, chatId),
          ...(workdir ? { projectPath: workdir } : {}),
        });
      } catch {
        // Уведомление — не часть хода: его сбой не должен задеть очередь.
      }
    }

    // Остановленному ответу очередь не досылается: человек остановил, панель
    // закрывается или разговор удалён — сообщения ждут следующего конца хода.
    if (!live.stopped) this.drainQueue(chatId, live.deps);
  }
}

/** Ждущие просьбы в порядке прихода — то, что видит карточка. */
function pendingViews(live: LiveRun): ProviderChatPermission[] {
  return [...live.asks.values()].map((pending) => pending.view);
}

/** Всё, что ещё ждёт, — отказом: ответить человек уже не успеет. */
function denyPending(live: LiveRun): void {
  const pending = [...live.asks.values()];
  live.asks.clear();
  for (const item of pending) item.resolve('deny');
}
