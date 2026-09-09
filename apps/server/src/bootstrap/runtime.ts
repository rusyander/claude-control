import { join } from 'node:path';
import type { ProjectTestRun, ProjectTestRunRequest } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { ChatRunRegistry, type RunNotice } from '../domains/chat/ChatRunRegistry.ts';
import { appendLoweredRun } from '../domains/chat/lowered-journal.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
} from '../domains/chat/run-ledger.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { TreePause } from '../domains/chat/tree-pause.ts';
import { createForeignStagePlanner, ProviderChatService } from '../domains/provider-chat.ts';
import { DEFAULT_PROVIDER_ID, getProvider, isKnownProviderId } from '../providers/registry.ts';
import { ProjectRunnerRegistry } from '../domains/project-runner.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../domains/project-tests.ts';
import { DlpProxy } from '../domains/dlp.ts';
import { createRunNotifier } from '../domains/remote-notify.ts';
import { createTelegramNotifier, type TelegramNotice } from '../domains/notify/telegram.ts';
import { createWebhookNotifier } from '../domains/notify/webhook.ts';
import { activateAtlassianMcp } from '../domains/integrations/mcp-server.ts';
import { hasWorkSince, readBranchFiles, readCurrentBranch } from '../domains/project-git.ts';
import { createHandoffPlanner } from '../routes/chat/handoff-routes.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { SplitOverlap } from '../domains/chat/split-overlap.ts';
import { SplitReview } from '../domains/chat/split-review.ts';
import {
  createReviewStarter,
  createSplitLauncher,
  launchFromRecord,
} from '../routes/chat/split-launch.ts';
import { commentMergeRequestByUrl, parseMergeRequestUrl } from '../domains/integrations/forge.ts';
import { readIntegrations, readToken } from '../domains/integrations/store.ts';
import { createEventHub, type EventHub } from '../lib/event-hub.ts';

/**
 * Объекты, живущие дольше запроса. Создаются при сборке приложения — только
 * оттуда их можно погасить при выходе — и подаются маршрутам замыканием
 * (см. `route-table.ts`), а не заводятся модулем маршрутов самостоятельно:
 * реестр, до которого никто снаружи не дотянется, при выходе осиротит свои
 * процессы.
 */
export interface Runtime {
  /** Dev-серверы проектов: спавненные процессы и порты, которые они назвали. */
  projectRunner: ProjectRunnerRegistry;
  /** Прогоны чатов Claude. */
  chatRuns: ChatRunRegistry;
  /** Права и автоподтверждение чатов — один объект на сервер. */
  chatSession: ChatSession;
  /** Прогоны GUI-тестов проектов. */
  projectTestRuns: ProjectTestRunRegistry;
  /** Ручные прогоны: кейсы проходит человек, панель записывает. */
  projectTestManual: ProjectTestManualRegistry;
  /** Уведомления на телефон о судьбе прогона. */
  notifyRun: ReturnType<typeof createRunNotifier>;
  /** Цепочки продолжений в чистой сессии. */
  handoffChains: HandoffChains;
  /** Пауза дерева разговоров; маршруты дерева и разделения берут её отсюда. */
  treePause: TreePause;
  /** Чаты чужих CLI. */
  providerChats: ProviderChatService;
  /** Конвейер уровней разделения (Т1): разбор → план → работа, ожидания между группами. */
  splitConveyor: SplitConveyor;
  splitOverlap: SplitOverlap;
  /** Ревью MR по ссылке (Т7): решение человека и его исполнение. */
  splitReview: SplitReview;
  /** Прокси защиты данных; поднимается отдельно, если включён в настройках. */
  dlpProxy: DlpProxy;
  /** Подписчики `/api/events` и рассылка об изменениях файлов. */
  events: EventHub;
  /** Адрес самой панели: его получает переходник MCP при регистрации. */
  selfBaseUrl: string;
  /** Погасить всё, что спавнит процессы. Идемпотентно. */
  shutdown: () => void;
}

export function createRuntime(ctx: ServerContext, selfBaseUrl: string): Runtime {
  // Реестр dev-серверов проектов — иначе спавненные процессы осиротеют; порт
  // становится известен уже после ответа на запуск (его печатает сам
  // dev-сервер), поэтому запоминает его реестр — через узкий колбэк, а не зная
  // про состояние панели.
  const projectRunner = new ProjectRunnerRegistry({
    onPortDiscovered: ({ projectPath, dir, port }) => {
      const target = dir ? join(projectPath, dir) : projectPath;
      ctx.store.rememberRunnerPort(target, port, { projectPath, dir });
    },
  });
  const chatRuns = new ChatRunRegistry();
  /**
   * Права и автоподтверждение чатов — один объект на сервер, а не на маршрут:
   * продолжение в чистой сессии заводит прогон мимо маршрута отправки, и
   * тумблеры закрытого разговора должны достаться новому.
   */
  const chatSession = new ChatSession(chatRuns);
  // Прогоны тестов — третий такой объект: агент ходит по кейсам минутами, и
  // оборванный при выходе панели процесс остался бы висеть с полным доступом.
  //
  // Обёртка над реестром вместо правки самого реестра: включение MCP —
  // обстоятельство внешнего мира, а реестр знает только про свои прогоны. Так же
  // сюда подаются уведомления и оценка стоимости.
  const projectTestRuns = new ActivatingTestRunRegistry((projectPath) => {
    activateAtlassianMcp(
      {
        paths: ctx.location.paths,
        store: ctx.store,
        backupDir: ctx.backupDir,
      },
      ctx.store,
      projectPath,
    );
  });
  // Ручной прогон живёт в памяти (его открывает один человек в одном окне), но
  // каждый отмеченный результат уходит на диск сразу. При выходе панели
  // незакрытая сессия помечается брошенной — иначе в истории остался бы прогон,
  // который «идёт» уже после смерти процесса.
  const projectTestManual = new ProjectTestManualRegistry();
  /**
   * Уведомления на телефон. Реестр прогонов знает, ЧТО случилось, но не знает ни
   * про устройства, ни про настройку — поэтому отправитель собирается здесь и
   * подаётся реестру тем же приёмом, что и оценка стоимости шага.
   */
  const notifyRun = createRunNotifier({
    isEnabled: () => ctx.store.getSettings().remoteAccess.notify,
    devices: () => ctx.store.getPushDevices(),
    forget: (token) => ctx.store.removePushDevice(token),
  });
  /**
   * Второй адресат тех же событий — Telegram.
   *
   * Push от Expo приходит в ПРИЛОЖЕНИЕ панели, и его видит только тот, у кого
   * оно установлено и спарено. Telegram получает и владелец без приложения, и
   * общий чат команды. Наружу уходит ровно заголовок — вид события и имя папки
   * проекта, — как и в push: содержимому разговора незачем покидать машину.
   */
  const telegram = createTelegramNotifier({
    settings: () => ctx.store.getSettings().integrations.telegram,
    token: () => readToken(ctx.location.paths.appData, 'telegram'),
  });
  /**
   * Третий адресат — вебхук: тот же заголовок, но своим адресом. Он закрывает
   * всё, чего нет у первых двух: Slack, Mattermost, дежурного бота, внутреннюю
   * шину. Подписка у него собственная, поэтому молчащий Telegram не означает
   * молчащий вебхук.
   */
  const webhook = createWebhookNotifier({
    settings: () => ctx.store.getSettings().integrations.webhook,
    secret: () => readToken(ctx.location.paths.appData, 'webhook'),
  });
  const notifyBoth = (notice: RunNotice): void => {
    notifyRun(notice);
    telegram(notice);
    webhook(notice);
  };
  chatRuns.setNotifier(notifyBoth);
  /**
   * Прогон тестов уведомляет тем же отправителем: он идёт десятки минут, и
   * сидеть перед панелью всё это время незачем.
   *
   * Для Telegram у него есть СВОЙ повод — «тесты провалены». Реестр о нём не
   * знает и знать не должен: он сообщает «прогон кончился», а провалы лежат в
   * итоге прогона, который он же и посчитал. Пересобирается это здесь, потому
   * что подписка на события — вопрос настройки, а не работы реестра.
   */
  projectTestRuns.setNotifier((notice) => {
    notifyRun(notice);
    const outward = testNotice(notice, projectTestRuns.get(notice.projectPath ?? ''));
    telegram(outward);
    webhook(outward);
  });
  /**
   * Дерево чатов переживает смену ключа. Разделение заводит чат под временным
   * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне —
   * и в списке чат появляется под ним. Без переноса связи ветвь дерева обрывалась
   * бы ровно в момент, когда чат становится настоящим.
   */
  chatRuns.setSessionListener((chatId, sessionId) => ctx.store.linkChatSession(chatId, sessionId));
  chatRuns.setFirstEditListener((keys, at) => ctx.store.markChatFirstEdit(keys, at));
  /**
   * Журнал понижённых прогонов: чем вели и видела ли панель проверки. Путь до
   * каталога данных знает bootstrap, а не реестр, — тем же приёмом, что и
   * уведомления.
   */
  chatRuns.setLoweredJournal((record) => appendLoweredRun(ctx.location.paths.appData, record));
  /**
   * Цепочки продолжений в чистой сессии: тумблер автомата и номер шага. Объект
   * переживает запрос — тумблер ставится в одном обращении, а срабатывает при
   * завершении прогона, возможно, уже без открытой вкладки.
   */
  const handoffChains = new HandoffChains(() => ctx.store.getSettings().handoffAutoDefault);
  /**
   * Кто решает, продолжать ли работу самому. Реестр знает только, что прогон
   * кончился; предохранители (свежесть файла-опоры, потолок цепочки, успешное
   * завершение) живут в домене и подаются сюда тем же приёмом, что и уведомления.
   */
  /**
   * Пауза дерева разговоров: «Остановить всё» у родителя. Живёт дольше запроса
   * по той же причине, что и цепочки: стоящее дерево должно глушить автостарты
   * планировщика и разделения, а те срабатывают при завершении прогона, когда
   * вкладки может не быть.
   */
  // Ревью по ссылке (Т7) собирается ниже — ему нужны и пауза дерева (прогон
  // правок откладывается ею), и запуск прогонов. Ссылка вперёд именно поэтому:
  // узел дерева спрашивает карточку у домена, а домен к тому моменту уже есть.
  const splitReviewRef: { current?: SplitReview } = {};
  const treePause = new TreePause({
    links: () => ctx.store.getChatLinks(),
    runs: chatRuns,
    store: {
      get: (root) => ctx.store.getTreePause(root),
      all: () => ctx.store.getTreePauses(),
      set: (record) => ctx.store.setTreePause(record),
      clear: (root) => ctx.store.clearTreePause(root),
    },
    autoApprove: {
      snapshot: (chatId) => chatSession.autoApproveFor(chatId),
      arm: (chatId, state) => chatSession.armAutoApprove(chatId, state),
    },
    reviewView: (link) => splitReviewRef.current?.view(link),
  });
  const providerChats = new ProviderChatService();
  /**
   * Конвейер уровней разделения (Т1). Память — в хранилище (`splitPlans`),
   * запуск групп — тем же лаунчером, что у маршрута `POST /api/chat/split`:
   * копии и прогоны заводятся одинаково, откуда бы ни пришёл сигнал — из
   * запроса человека, из конца разбора или из конца цепочки соседней группы.
   */
  const launchDeps = {
    runs: chatRuns,
    providerChats,
    session: chatSession,
    gate: treePause,
    log: {
      warn: (detail: { err: unknown }, message: string) => console.warn(message, detail.err),
    },
  };
  /**
   * Сверка веток разделения после работы (Т6). Живёт рядом с конвейером и на той
   * же записи: разбор уровня 1 обещал границы, а здесь панель спрашивает у git,
   * что вышло на самом деле. Ничего не сливает и не правит — только читает.
   */
  const splitOverlap = new SplitOverlap({
    git: {
      mergeBase: (mainDir) => readCurrentBranch(mainDir),
      changedFiles: (input) => readBranchFiles(input),
    },
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
    },
    // Заметка идёт в ленту РОДИТЕЛЯ: разделение — его решение, и сводка групп
    // тоже его. Прогона у родителя нет — `false`, и факт подождёт (см. домен).
    emit: (parentChatId, event) => chatRuns.emitExternal(parentChatId, event),
    log: (message, error) => console.warn(message, error),
  });
  /**
   * Ревью запроса на слияние по ссылке (Т7). Домен решает, что делать с
   * замечаниями, а всё, что умеет ПИСАТЬ, подаётся сюда снаружи: комментарий в
   * MR — интеграцией форджа, правки — обычным прогоном в копии группы. Ни то,
   * ни другое не случается само: и то и другое — клик человека.
   */
  const forgeToken = () => readToken(ctx.location.paths.appData, 'forge');
  const splitReview = new SplitReview({
    store: {
      all: () => ctx.store.getChatLinks(),
      set: (chatId, link) => ctx.store.setChatLink(chatId, link),
    },
    post: async (url, body) => {
      const token = forgeToken();
      if (!token) throw new Error('токен форджа не сохранён в настройках панели');
      await commentMergeRequestByUrl(url, token, body);
    },
    // Причину спрашиваем на каждый показ карточки: интеграцию включают и
    // выключают, а кнопка, которая заведомо откажет, хуже отсутствующей.
    postBlocked: (url) => {
      if (!parseMergeRequestUrl(url)) return 'ссылка не похожа на запрос на слияние';
      if (!readIntegrations(ctx.store).forge.enabled) {
        return 'интеграция с форджем выключена в настройках панели';
      }
      return forgeToken() ? undefined : 'токен форджа не сохранён в настройках панели';
    },
    start: createReviewStarter(ctx, launchDeps),
    // Заметка — в ленту родителя: карточку решения человек ищет в хабе.
    emit: (parentChatId, event) => chatRuns.emitExternal(parentChatId, event),
    log: (message, error) => console.warn(message, error),
  });
  splitReviewRef.current = splitReview;

  const splitConveyor = new SplitConveyor({
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
      findByTriage: (chatIds) => ctx.store.findSplitPlanByTriage(chatIds),
      all: () => ctx.store.getSplitPlans(),
    },
    watchOverlap: (parentChatId) => {
      void splitOverlap.check(parentChatId).catch((error) => {
        console.warn('split overlap: check after chain end failed', error);
      });
    },
    launch: (record, groups, context) => launchFromRecord(ctx, launchDeps, record, groups, context),
    startTriage: (record, prompt) =>
      createSplitLauncher(ctx, launchDeps, {
        projectPath: record.projectPath,
        parentChatId: record.parentChatId,
        ...(record.request.model ? { model: record.request.model } : {}),
        ...(record.request.effort ? { effort: record.request.effort } : {}),
      }).startTriage(prompt),
    log: (message, error) => console.warn(message, error),
  });
  chatRuns.setHandoffPlanner(
    createHandoffPlanner({
      runs: chatRuns,
      chains: handoffChains,
      gate: treePause,
      session: chatSession,
      selfBaseUrl,
      contextLimit: () => ctx.store.getSettings().handoffContextLimit,
      // Продолжение наследует связь закрытого разговора: и родителя в дереве, и
      // подобранную под задачу модель. Иначе следующее сообщение человека —
      // первое, что придёт в новый чат без модели, — уехало бы на дефолте.
      carryLink: (from, to) => {
        const link = from.map((key) => ctx.store.getChatLink(key)).find(Boolean);
        if (link) ctx.store.setChatLink(to, { ...link, createdAt: new Date().toISOString() });
      },
      /**
       * Конвейер «работа → ревью → фикс»: чем оплачивается понижение модели.
       * Всё, что ему нужно снаружи, — связи чатов, настройки и один вопрос к
       * git. Решение о звене принимает домен (`ChatCascadeStages`), запускает
       * планировщик, а собирается это здесь, как и остальные долгоживущие связки.
       */
      cascade: {
        linkOf: (aliases) => aliases.map((key) => ctx.store.getChatLink(key)).find(Boolean),
        saveLink: (chatId, link) => ctx.store.setChatLink(chatId, link),
        // Отметка ставится по ОБОИМ ключам чата: под временным он живёт в памяти
        // вкладок, под настоящим — в списке, и проверить работу дважды нельзя ни
        // из того, ни из другого.
        markReviewed: (aliases, at) => {
          for (const key of aliases) {
            const link = ctx.store.getChatLink(key);
            if (link) ctx.store.setChatLink(key, { ...link, reviewedAt: at });
          }
        },
        // Та же отметка для плана (Т1): вторая работа той же группы не заводится.
        markPlanned: (aliases, at) => {
          for (const key of aliases) {
            const link = ctx.store.getChatLink(key);
            if (link) ctx.store.setChatLink(key, { ...link, plannedAt: at });
          }
        },
        hasWork: (cwd, since) => hasWorkSince(cwd, since),
        settings: () => ctx.store.getSettings(),
      },
      split: {
        onTriageFinished: (finished, aliases) => splitConveyor.onTriageFinished(finished, aliases),
        onChainEnded: (link, ok) => splitConveyor.onChainEnded(link, ok),
      },
      // Ревью по ссылке (Т7): замечания из ответа — в связь, карточка — человеку.
      review: { onReviewFinished: (input) => splitReview.finished(input) },
    }),
  );
  /**
   * Тот же конвейер «работа → ревью → правки», но у чужих CLI. Живёт не на
   * реестре прогонов (их разговоры идут мимо него вовсе), а на завершении ответа
   * и стадии в шапке разговора; решение принимает домен, снаружи ему нужны
   * провайдер, каталог моделей, настройки и один вопрос к git.
   */
  providerChats.setFinishedListener(
    createForeignStagePlanner({
      chats: providerChats,
      // Claude сюда не попадает никогда: у него свой чат и свой конвейер.
      // Незнакомый id — не звено: `getProvider` откатился бы на Claude, а тот
      // отказался бы запускаться, оставив в переписке ошибку на пустом месте.
      provider: (id) =>
        id !== DEFAULT_PROVIDER_ID && isKnownProviderId(id) ? getProvider(id) : undefined,
      models: (provider) => ctx.models.current(provider.modelVendors ?? []).models,
      settings: () => ctx.store.getSettings(),
      hasWork: (cwd, since) => hasWorkSince(cwd, since),
    }),
  );
  // Прокси защиты данных: тоже слушатель, тоже переживает запрос. Создаётся
  // всегда, поднимается — только если человек включил его в настройках.
  const dlpProxy = new DlpProxy();
  const events = createEventHub();

  /**
   * Журнал идущих прогонов на диске и усыновление живых после перезапуска.
   *
   * `node --watch` на Windows убивает сервер без обработчиков (`shutdown` ниже
   * не срабатывает), и процессы CLI живут дальше сиротами. Раньше их запросы
   * прав встречали пустой реестр — «Разговор не найден» на каждый вызов. Теперь
   * реестр пишет каждый прогон в `<appData>/runs.json`, а здесь, когда ВСЕ
   * крючки уже стоят (уведомления, планировщик), подхватывает те, чей процесс
   * жив: место в реестре, карточка прав, «Остановить» — без потока вывода.
   * Тумблеры автоподтверждения возвращаются из снимка в журнале: без них
   * усыновлённый прогон спрашивал бы о каждом вызове. Мёртвое вычищается.
   */
  const runLedger = new RunLedger(ctx.location.paths.appData);
  chatRuns.setLedger(runLedger, (key) => chatSession.autoApproveFor(key));
  const { adopt, drop } = adoptableEntries(runLedger.read(), {
    isAlive: isPidAlive,
    looksLikeCli: pidLooksLikeCli,
  });
  for (const entry of drop) runLedger.remove(entry.key);
  for (const entry of adopt) {
    if (entry.autoApprove) chatSession.armAutoApprove(entry.key, entry.autoApprove);
    if (!chatRuns.adopt(entry)) runLedger.remove(entry.key);
  }

  // Спавненные dev-серверы проектов, CLI чатов и прогоны тестов живут в памяти
  // процесса. Гасим их при выходе, чтобы дочерние процессы не осиротели и не
  // держали занятыми порты.
  const shutdown = (): void => {
    // Чаты Claude — тоже: без этого перезапуск панели оставлял их CLI сиротами,
    // и агент дописывал транскрипт, которого никто уже не читал, тратя лимит.
    chatRuns.stopAll();
    projectRunner.stopAll();
    providerChats.stopAll();
    projectTestRuns.stopAll();
    projectTestManual.stopAll(new Date().toISOString());
  };

  return {
    projectRunner,
    chatRuns,
    chatSession,
    projectTestRuns,
    projectTestManual,
    notifyRun,
    handoffChains,
    treePause,
    providerChats,
    splitConveyor,
    splitOverlap,
    splitReview,
    dlpProxy,
    events,
    selfBaseUrl,
    shutdown,
  };
}

/**
 * Реестр прогонов тестов, включающий переходник MCP на старте.
 *
 * Наследование, а не правка реестра: включение — обстоятельство внешнего мира
 * (есть ли привязка, зарегистрирован ли сервер), и реестру прогонов о нём знать
 * нечего. Включаем ДО запуска: агент стартует тут же, и запись, включённая
 * после, досталась бы только следующему прогону.
 */
class ActivatingTestRunRegistry extends ProjectTestRunRegistry {
  private readonly onStart: (projectPath: string) => void;

  constructor(onStart: (projectPath: string) => void) {
    super();
    this.onStart = onStart;
  }

  override start(request: ProjectTestRunRequest, now: string): ProjectTestRun {
    // `activateAtlassianMcp` не бросает по своему устройству: интеграция не
    // главнее работы, и прогон обязан пойти даже с мёртвым переходником.
    this.onStart(request.projectPath);
    return super.start(request, now);
  }
}

/**
 * Уведомление о прогоне тестов для Telegram: провалы важнее самого факта
 * завершения.
 *
 * Итог прогона уже посчитан реестром к моменту рассылки, поэтому число берётся
 * из него, а не считается заново. Провалов нет — уходит обычное «работа
 * закончена».
 */
function testNotice(notice: RunNotice, run: ProjectTestRun | undefined): TelegramNotice {
  const failed = run?.summary?.failed ?? 0;
  if (failed === 0) return notice;
  return {
    kind: 'testFailed',
    chatId: notice.chatId,
    projectPath: notice.projectPath,
    failed,
    total: run?.summary?.total,
  };
}

/** Гасить процессы и на обычном выходе, и по сигналу — иначе Ctrl+C оставляет сирот. */
export function installShutdownHandlers(runtime: Runtime): void {
  process.on('exit', runtime.shutdown);
  process.on('SIGINT', () => {
    runtime.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    runtime.shutdown();
    process.exit(0);
  });
}
