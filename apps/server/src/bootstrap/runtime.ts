import { join } from 'node:path';
import type { ServerContext } from '../context.ts';
import { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { ProjectRunnerRegistry } from '../domains/project-runner.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../domains/project-tests.ts';
import { DlpProxy } from '../domains/dlp.ts';
import { createRunNotifier } from '../domains/remote-notify.ts';
import { hasWorkSince } from '../domains/project-git.ts';
import { createHandoffPlanner } from '../routes/chat/handoff-routes.ts';
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
  /** Чаты чужих CLI. */
  providerChats: ProviderChatService;
  /** Прокси защиты данных; поднимается отдельно, если включён в настройках. */
  dlpProxy: DlpProxy;
  /** Подписчики `/api/events` и рассылка об изменениях файлов. */
  events: EventHub;
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
  const projectTestRuns = new ProjectTestRunRegistry();
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
  chatRuns.setNotifier(notifyRun);
  // Прогон тестов уведомляет тем же отправителем: он идёт десятки минут, и
  // сидеть перед панелью всё это время незачем.
  projectTestRuns.setNotifier(notifyRun);
  /**
   * Дерево чатов переживает смену ключа. Разделение заводит чат под временным
   * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне —
   * и в списке чат появляется под ним. Без переноса связи ветвь дерева обрывалась
   * бы ровно в момент, когда чат становится настоящим.
   */
  chatRuns.setSessionListener((chatId, sessionId) => ctx.store.linkChatSession(chatId, sessionId));
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
  chatRuns.setHandoffPlanner(
    createHandoffPlanner({
      runs: chatRuns,
      chains: handoffChains,
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
        hasWork: (cwd, since) => hasWorkSince(cwd, since),
        settings: () => ctx.store.getSettings(),
      },
    }),
  );
  const providerChats = new ProviderChatService();
  // Прокси защиты данных: тоже слушатель, тоже переживает запрос. Создаётся
  // всегда, поднимается — только если человек включил его в настройках.
  const dlpProxy = new DlpProxy();
  const events = createEventHub();

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
    providerChats,
    dlpProxy,
    events,
    shutdown,
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
