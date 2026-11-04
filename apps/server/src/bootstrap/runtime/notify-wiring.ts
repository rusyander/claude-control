import { join } from 'node:path';
import type { ProjectTestRun } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunNotice } from '../../domains/notify/run-notice.types.ts';
import { findTranscript } from '../../domains/chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import {
  createCoreAccess,
  createCoreRelay,
  RELAY_STATE_FILE,
  type CoreRelay,
} from '../../domains/core-relay/index.ts';
import { readToken } from '../../domains/integrations/store/store.ts';
import { createCoreAskDelivery } from '../../domains/notify/core-ask-delivery.ts';
import { coreTaskLink } from '../../domains/notify/core-notice.ts';
import { createOutsideDone } from '../../domains/notify/outside-done.ts';
import { SentLog } from '../../domains/notify/telegram-answers/sent-log.ts';
import { writeLastSend } from '../../domains/notify/telegram-delivery.ts';
import {
  createTelegramNotifier,
  type TelegramAnswersCover,
  type TelegramNotice,
} from '../../domains/notify/telegram.ts';
import { createWebhookNotifier } from '../../domains/notify/webhook.ts';
import type { ProjectTestRunRegistry } from '../../domains/project-tests/project-tests.ts';
import { createRunNotifier, sendExpoPush } from '../../domains/remote-notify.ts';
import { panelHomeDir } from '../../lib/brand.mjs';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import { machineId } from '../../lib/machine-identity/machine-identity.ts';
import { getProvider, isKnownProviderId } from '../../providers/registry.ts';
import { registerTelegramAnswersRoutes } from '../../routes/integrations/telegram-answers-routes.ts';
import type { RouteRegistrar } from '../../routes/register.ts';
import { registerRemoteRoutes } from '../../routes/remote-routes.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { chatTitleOf } from './chat-title.ts';

/**
 * Проводка уведомлений (этап 10, зона notify): push, Telegram, вебхук и «Закончил» сессии вне
 * панели. Вынесена из `runtime.ts`, чтобы зона, переводящая уведомления на ядро, правила один
 * файл, а не общий фасад; поведение то же, что было на месте.
 */
export interface NotifyWiring {
  notifyRun: ReturnType<typeof createRunNotifier>;
  telegramAnswersCover: TelegramAnswersCover;
  telegram: ReturnType<typeof createTelegramNotifier>;
  webhook: ReturnType<typeof createWebhookNotifier>;
  outsideTurnEnded: (sessionId: string) => void;
  /** Пересылка вопросов ядра; `null` — выключена (vitest, `AGENTDECK_CORE_RELAY=0`). */
  coreRelay: CoreRelay | null;
}

export interface NotifyWiringDeps {
  chatRuns: ChatRunRegistry;
  projectTestRuns: Pick<ProjectTestRunRegistry, 'setNotifier' | 'get'>;
}

export function wireNotify(ctx: ServerContext, deps: NotifyWiringDeps): NotifyWiring {
  const { chatRuns, projectTestRuns } = deps;
  /**
   * Уведомления на телефон. Реестр прогонов знает, ЧТО случилось, но не знает ни
   * про устройства, ни про настройку — поэтому отправитель собирается здесь и
   * подаётся реестру тем же приёмом, что и оценка стоимости шага.
   */
  const notifyRun = createRunNotifier({
    isEnabled: () => ctx.store.getSettings().remoteAccess.notify,
    devices: () => ctx.store.getPushDevices(),
    forget: (token) => ctx.store.removePushDevice(token),
    machineId: () => machineId(),
  });
  /**
   * Второй адресат тех же событий — Telegram.
   *
   * Push от Expo приходит в ПРИЛОЖЕНИЕ панели, и его видит только тот, у кого
   * оно установлено и спарено. Telegram получает и владелец без приложения, и
   * общий чат команды. Наружу уходят событие, папка проекта, имя чата и одна
   * строка сути (`telegram-text.ts`) — без кода, путей и промпта. Конец хода —
   * только «задача закрыта» (одна-две фразы итога под маской) или «агент ждёт
   * вас» (что решить); промежуточная остановка молчит (`notify/turn-end/`).
   */
  const telegramAnswersCover: TelegramAnswersCover = { covers: () => false };
  const telegram = createTelegramNotifier({
    settings: () => ctx.store.getSettings().integrations.telegram,
    token: () => readToken(ctx.location.paths.appData, 'telegram'),
    titleOf: (chatId) => chatTitleOf(ctx, chatRuns, chatId),
    openIdOf: (chatId) => ctx.store.canonicalChatKey(chatId),
    cliNameOf: (id) => (isKnownProviderId(id) ? getProvider(id).name : undefined),
    // Опрос ответов живёт в маршрутах и подставляет сюда своё «покрываю».
    answersCover: () => telegramAnswersCover.covers(),
    // Конец хода, за которым чат снова работает, — промежуточный. Ход чужого CLI
    // идёт задачей ядра (этап 10, F2c), и о нём говорит пересылка ядра, а не этот
    // уведомитель: занятость здесь — только у прогонов реестра чата.
    busy: (chatId) => chatRuns.isRunning(chatId),
    // Звено группы: о его шагах молчим, итог скажет группа.
    subtask: (chatId) =>
      [chatId, ctx.store.canonicalChatKey(chatId)].some((key) =>
        Boolean(ctx.store.getChatLink(key)?.parentChatId),
      ),
    onResult: (result) => writeLastSend(ctx.location.paths.appData, result),
    // Номер отправленного — для /clear; уведомления сами не удаляются (это запись).
    onSent: (chatId, messageId, route) =>
      new SentLog(ctx.location.paths.appData).record({
        chatId,
        messageId,
        at: Date.now(),
        kind: 'bot',
        ...(route ? { route } : {}),
      }),
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
  /**
   * Сессия из терминала или VS Code кончила ход — карточка только в Telegram,
   * только после долгой работы (порог карточки) и только «закрыта» или «ждёт»
   * (суд по транскрипту, `outside-done.ts`): push и вебхук о таких сессиях не
   * сообщали и не обещали.
   */
  const outsideTurnEnded = createOutsideDone({
    transcriptOf: (sessionId) =>
      findTranscript(join(ctx.location.paths.root, 'projects'), sessionId),
    ownSession: (sessionId) => chatRuns.active().some((run) => run.sessionId === sessionId),
    notify: (notice) => telegram(notice),
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
  const coreRelay = wireCoreRelay(ctx, telegramAnswersCover);
  return {
    notifyRun,
    telegramAnswersCover,
    telegram,
    webhook,
    outsideTurnEnded,
    coreRelay,
  };
}

export const CORE_RELAY_ENV = 'AGENTDECK_CORE_RELAY';

/**
 * Пересылка вопросов ядра задач (этап 10, Q9): поток ядра → push и Telegram со ссылкой на задачу.
 * Под vitest не заводится (тест рантайма пошёл бы к ядру настоящего дома), `AGENTDECK_CORE_RELAY=0`
 * выключает руками. Состояние — в доме панели, рядом с номером машины: переживает перезапуск.
 */
function wireCoreRelay(
  ctx: ServerContext,
  cover: TelegramAnswersCover,
  env: NodeJS.ProcessEnv = process.env,
): CoreRelay | null {
  if (env.VITEST || env[CORE_RELAY_ENV] === '0') return null;
  const log = (line: string): void => console.log(line);
  const sentLog = new SentLog(ctx.location.paths.appData);
  const channels = createCoreAskDelivery({
    telegram: () => ctx.store.getSettings().integrations.telegram,
    token: () => readToken(ctx.location.paths.appData, 'telegram'),
    answersCover: () => cover.covers(),
    sentLog,
    pushEnabled: () => ctx.store.getSettings().remoteAccess.notify,
    devices: () => ctx.store.getPushDevices(),
    machineId: () => machineId(),
    push: (messages) =>
      sendExpoPush(messages, (token) => {
        ctx.store.removePushDevice(token);
      }),
    onTelegramResult: (result) =>
      writeLastSend(ctx.location.paths.appData, {
        at: new Date().toISOString(),
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      }),
    log,
  });
  const relay = createCoreRelay({
    core: createCoreAccess(() => coreHomeOf(env)),
    statePath: join(panelHomeDir(), RELAY_STATE_FILE),
    deliver: ({ notice, question }) => channels.deliver(notice, question),
    ready: () => channels.ready(),
    link: (taskId, askId) => coreTaskLink(taskId, askId),
    log,
  });
  relay.start();
  return relay;
}

export interface NotifyRouteDeps {
  chatRuns: ChatRunRegistry;
  chatSession: ChatSession;
  telegramAnswersCover: TelegramAnswersCover;
  chatTitle: (chatId: string) => string | undefined;
  notifyRun: NotifyWiring['notifyRun'];
}

/** Маршруты зоны уведомлений — таблица маршрутов вставляет их на прежнее место. */
export function notifyRoutes(deps: NotifyRouteDeps): RouteRegistrar[] {
  return [
    // Ответы из Telegram: опрос бота живёт с сервером и отвечает маршрутами
    // разговоров — ему нужны реестр прогонов, права сессии и чужие чаты.
    (instance, context) =>
      registerTelegramAnswersRoutes(instance, context, {
        registry: deps.chatRuns,
        session: deps.chatSession,
        cover: deps.telegramAnswersCover,
        chatTitle: deps.chatTitle,
      }),
    (instance, context) => registerRemoteRoutes(instance, context, deps.notifyRun),
  ];
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
