import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppSettings } from '@agentdeck/contracts';
import {
  HANDOFF_MAX_CHAIN,
  HANDOFF_SYSTEM_PROMPT,
  parseHandoffProposal,
  scanHandoffBlocks,
} from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent } from '../../domains/chat/ChatRunner.ts';
import type { ChatRunRegistry, RunFinished } from '../../domains/chat/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import { planContextRotation } from '../../domains/chat/context-rotation.ts';
import { activateGroupsQuietly } from '../../domains/group-activation.ts';
import {
  evaluateHandoff,
  startHandoff,
  type HandoffChains,
  type StatFile,
} from '../../domains/chat/ChatHandoff.ts';
import { planCascadeStage, stageAppendPrompt } from '../../domains/chat/ChatCascadeStages.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { createChat, type ProviderChatService } from '../../domains/provider-chat.ts';
import { checkProjectDir } from '../../domains/projects.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { activeCliCommand } from '../../providers/cli.ts';
import { apiTokenPath } from '../../lib/api-token.ts';

/**
 * Продолжение работы в чистой сессии — маршруты и планировщик.
 *
 * Здесь два входа, и они намеренно разные.
 *
 * РУЧНОЙ (`POST /api/chat/handoff`) — человек нажал кнопку на карточке. Проверок
 * почти нет: предохранители существуют против САМОСТОЯТЕЛЬНОГО решения панели, а
 * решение человека они не отменяют. Ему их показывают на карточке, и всё.
 *
 * АВТОМАТИЧЕСКИЙ (планировщик) — панель продолжает сама, и вот тут проверяется
 * каждое условие: тумблер этого разговора, успешное завершение прогона, потолок
 * цепочки и свежесть файла-опоры. Планировщик живёт на сервере, а не в браузере,
 * потому что закрытая вкладка не должна ломать цепочку: агент работает ночью, а
 * человек смотрит утром.
 *
 * Ключи разговора берём в обоих написаниях (`chatId` и `sessionId`): тумблер,
 * поставленный во вкладке, знающей чат по сессии, обязан действовать и на
 * прогон, зарегистрированный под временным `new-…`.
 */

/** Оба написания ключа одного разговора, без пустых. */
function aliasesOf(chatId?: string, sessionId?: string): string[] {
  return [chatId, sessionId].filter((value): value is string => Boolean(value));
}

export interface HandoffPlannerDeps {
  runs: ChatRunRegistry;
  chains: HandoffChains;
  /** Тумблеры прав сервера: новый разговор наследует их у закрытого. */
  session: ChatSession;
  /** Адрес самой панели — его слушает мини-MCP-сервер прав нового прогона. */
  selfBaseUrl: string;
  /**
   * Порог контекста из настроек, читаемый на каждом завершении: настройку меняют
   * при живом сервере, и запомненное при старте число врало бы до перезапуска.
   * Ноль — за размером окна не следим.
   */
  contextLimit?: () => number;
  /**
   * Перенести связь закрываемого разговора на продолжение. Прогон продолжения
   * идёт теми же параметрами и без этого (они копируются целиком), но СЛЕДУЮЩЕЕ
   * сообщение человека приходит уже без модели — и без записи уехало бы на
   * дефолте, посреди работы, которую вели подобранной моделью.
   */
  carryLink?: (from: string[], to: string) => void;
  /**
   * Конвейер подбора модели: чем платится понижение. Нет поля — звеньев ревью и
   * правок не бывает вовсе, и всё ведёт себя как до этапа 2.
   */
  cascade?: CascadeStageDeps;
  /** Время правки файла; подменяется в тестах. */
  stat?: StatFile;
}

/** Что планировщику нужно снаружи, чтобы завести звено конвейера. */
export interface CascadeStageDeps {
  /** Связь закончившегося чата — по любому из его ключей. */
  linkOf: (aliases: string[]) => ChatLink | undefined;
  /** Записать связь нового звена. Строго ДО запуска (см. `SplitLink`). */
  saveLink: (chatId: string, link: ChatLink) => void;
  /** Отметить работу проверенной — по всем ключам чата, чтобы не завести второе ревью. */
  markReviewed: (aliases: string[], at: string) => void;
  /** Изменила ли работа что-нибудь в копии: пустой дифф проверять незачем. */
  hasWork: (cwd: string, since?: string) => boolean;
  /** Настройки — из них собирается системная дописка звена. */
  settings: () => Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>;
}

/**
 * Планировщик продолжения: решает по завершившемуся прогону, начинать ли новую
 * сессию, и возвращает событие для ленты. `undefined` — молчим: блока не было
 * или автопродолжение не включали, и говорить человеку не о чем.
 *
 * Отказ по любой ДРУГОЙ причине — событие с `reason`: человек включил автомат и
 * вправе узнать, почему он не сработал, иначе панель выглядит сломанной.
 */
export function createHandoffPlanner({
  runs,
  chains,
  session,
  selfBaseUrl,
  contextLimit,
  carryLink,
  cascade,
  stat,
}: HandoffPlannerDeps): (finished: RunFinished) => ChatEvent | undefined {
  /**
   * Звено конвейера подбора модели: проверка работы на потолке и правки по её
   * замечаниям. Считается ПОСЛЕ продолжения в чистой сессии и только когда то не
   * состоялось — предложение агента сильнее: оно означает, что работа ещё идёт,
   * а проверять надо законченное.
   */
  function planStage(finished: RunFinished, aliases: string[]): ChatEvent | undefined {
    if (!cascade || !finished.projectPath) return undefined;
    // Потолок цепочки общий с продолжением: звенья — такие же прогоны, заведённые
    // панелью, и предохранитель от бесконечности у них обязан быть один.
    if (chains.depth(aliases) >= HANDOFF_MAX_CHAIN) return undefined;

    const link = cascade.linkOf(aliases);
    const cwd = finished.projectPath;
    const plan = planCascadeStage({
      ...(link ? { link } : {}),
      ok: finished.ok,
      text: finished.text,
      task: finished.options.prompt ?? '',
      hasWork: () => cascade.hasWork(cwd, link?.createdAt),
    });
    if (!plan) return undefined;

    const chatId = `new-${Date.now()}`;
    // Связь и отметка «проверено» пишутся ДО запуска. Связь — потому что перенос
    // на настоящий `sessionId` ищет запись по временному ключу и, не найдя, молча
    // ничего не делает; отметка — потому что упавший запуск не повод завести
    // вторую проверку той же работы на следующем же сообщении человека.
    cascade.saveLink(chatId, plan.link);
    if (plan.stage === 'review') cascade.markReviewed(aliases, new Date().toISOString());

    const options = { ...finished.options, prompt: plan.prompt };
    delete options.sessionId;
    delete options.fork;
    delete options.name;
    options.model = plan.model;
    options.effort = plan.effort;
    options.permissionPrompt = { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() };
    // Дописка собирается заново по стадии: у работы в ней лежит планка сдачи
    // «тебя ведёт модель ниже потолка», и в ревью она сказала бы проверяющему
    // ровно обратное тому, зачем его завели.
    const append = stageAppendPrompt(plan, cascade.settings());
    if (append) options.appendSystemPrompt = append;
    else delete options.appendSystemPrompt;

    // Права наследуются от работы: звено заводится, когда человека у панели по
    // построению нет, и запрос прав остановил бы конвейер на первом же чтении.
    runs.muteSplit(chatId);
    session.inherit(aliases, chatId);
    const chainDepth = chains.link(aliases, chatId);
    // Правки идут ниже потолка так же, как работа, — значит и в журнал сдачи
    // попадают так же. Ревью в него не попадает: оно идёт НА потолке, понижать
    // там нечего и оплачивать нечем.
    const meta = {
      projectPath: cwd,
      ...(plan.stage === 'fix'
        ? {
            lowered: {
              model: plan.model,
              effort: plan.effort,
              ...(link?.kind ? { kind: link.kind } : {}),
            },
          }
        : {}),
    };
    if (!runs.start(chatId, options, meta)) return undefined;

    return {
      kind: 'handoff',
      chatId,
      path: cwd,
      chainDepth,
      stage: plan.stage,
      ...(plan.findings ? { findings: plan.findings } : {}),
    };
  }

  return (finished) => {
    const own = scanHandoffBlocks(finished.text).proposals.at(-1);
    const aliases = aliasesOf(finished.chatId, finished.sessionId);

    // Второй повод продолжить — размер окна. Предложение агента его перебивает:
    // оно знает, ЧТО закрыто, а порог знает только «сколько накопилось».
    const rotation = planContextRotation({
      contextTokens: finished.contextTokens,
      limit: contextLimit?.() ?? 0,
      hasProposal: Boolean(own),
      ok: finished.ok,
      hasProject: Boolean(finished.projectPath),
    });
    const proposal = own ?? (rotation.kind === 'propose' ? rotation.proposal : undefined);

    const verdict = evaluateHandoff({
      ...(proposal ? { proposal } : {}),
      ...(finished.projectPath ? { cwd: finished.projectPath } : {}),
      ok: finished.ok,
      startedAt: finished.startedAt,
      auto: chains.isAuto(aliases),
      depth: chains.depth(aliases),
      ...(stat ? { stat } : {}),
    });

    if (!verdict.ok) {
      // Продолжения не будет — значит работа закончена, и настал черёд конвейера.
      // Порядок именно такой: предложение агента означает, что он ещё в работе,
      // и проверять на этом месте было бы нечего.
      const staged = planStage(finished, aliases);
      if (staged) return staged;

      if (verdict.reason === 'no_block') return undefined;
      // Повод по порогу молчать не должен, даже когда автомат выключен: человек
      // не видит размера окна и узнать о нём может только отсюда. Но и повторять
      // на каждом ходу нельзя — окно за порогом само не уменьшается.
      if (rotation.kind === 'propose') {
        if (!chains.shouldNoticeContext(aliases, rotation.contextTokens)) return undefined;
        return {
          kind: 'handoff',
          reason: verdict.reason === 'auto_off' ? 'context_high' : verdict.reason,
          contextTokens: rotation.contextTokens,
        };
      }
      if (verdict.reason === 'auto_off') return undefined;
      return { kind: 'handoff', reason: verdict.reason };
    }

    const cwd = finished.projectPath as string;
    const started = startHandoff({
      proposal: verdict.proposal,
      cwd,
      fromAliases: aliases,
      chains,
      startRun: true,
      start: ({ chatId, prompt }) => {
        // Продолжение идёт ТЕМИ ЖЕ параметрами: модель, глубина, права, команда
        // CLI и системные дописки — всё от закрытого прогона. Меняются ровно
        // три вещи: текст, отсутствие сессии (это и есть чистый лист) и адрес
        // запросов прав, привязанный к новому ключу.
        const options = { ...finished.options, prompt };
        delete options.sessionId;
        delete options.fork;
        delete options.name;
        options.permissionPrompt = {
          runId: chatId,
          baseUrl: selfBaseUrl,
          tokenFile: apiTokenPath(),
        };
        // Тумблеры и молчание про разделение — тоже от закрытого разговора:
        // системная дописка скопирована с его состоянием, а автоподтверждение
        // без наследования встало бы на первом же запросе прав, пока человека
        // нет у панели, — ради чего цепочка и заводилась.
        if (runs.isSplitMuted(finished.chatId)) runs.muteSplit(chatId);
        session.inherit(aliases, chatId);
        // Связь — тоже от закрытого разговора, и строго ДО запуска: перенос на
        // настоящий `sessionId` ищет запись по временному ключу и, не найдя,
        // молча ничего не делает (см. `SplitLink`).
        carryLink?.(aliases, chatId);
        return runs.start(chatId, options, { projectPath: cwd });
      },
    });

    return {
      kind: 'handoff',
      chatId: started.chatId,
      path: started.path,
      chainDepth: started.chainDepth,
      ...(rotation.kind === 'propose' ? { contextTokens: rotation.contextTokens } : {}),
    };
  };
}

export function registerChatHandoffRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: {
    runs: ChatRunRegistry;
    chains: HandoffChains;
    providerChats: ProviderChatService;
    /** Тумблеры прав сервера: продолжение наследует их у закрытого разговора. */
    session: ChatSession;
  },
): void {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  app.post<{
    Body: {
      /** Каталог разговора: продолжение идёт в нём же, ветку не меняем. */
      projectPath?: string;
      /** Ключи закрываемого разговора — от них наследуется цепочка. */
      chatId?: string;
      sessionId?: string;
      /** Предложение агента — ровно то, что было в блоке ответа. */
      proposal?: unknown;
      /** Запускать прогон сразу; false — только завести чат с заданием. */
      startRun?: boolean;
      allowEdits?: boolean;
      model?: string;
      effort?: string;
    };
  }>('/api/chat/handoff', async (request, reply) => {
    const { projectPath, chatId, sessionId, startRun, allowEdits, model, effort } =
      request.body ?? {};

    const problem = checkProjectDir(String(projectPath ?? ''));
    if (problem) return reply.code(400).send({ message: problem });
    const dir = resolve(projectPath as string);

    // Разбор тот же самый, которым панель узнаёт блок в ответе: два понимания
    // формата — два разных задания новой сессии при одном и том же тексте.
    const proposal = parseHandoffProposal(request.body?.proposal);
    if (!proposal) {
      return reply
        .code(400)
        .send({ message: 'Предложение не разобрано: нужны «что закрыто» и «чем продолжить»' });
    }

    const provider = getActiveProvider(ctx.store);
    const wantRun = startRun !== false;

    // Чем ведётся ЗАКРЫВАЕМЫЙ разговор. Продолжение — тот же разговор по смыслу,
    // и модель у него обязана быть та же: чат, заведённый разделением, работает
    // подобранной под его задачу, и «чистая сессия» не повод вернуть его на
    // дефолт из настроек. Ключей у разговора два (временный и `sessionId`) —
    // смотрим оба, связь переезжает на второй.
    const assigned =
      ctx.store.getChatLink(String(chatId ?? '')) ??
      (sessionId ? ctx.store.getChatLink(sessionId) : undefined);

    return startHandoff({
      proposal,
      cwd: dir,
      fromAliases: aliasesOf(chatId, sessionId),
      chains: deps.chains,
      startRun: wantRun,
      start: ({ chatId: nextId, prompt, cwd }) => {
        // Продолжение идёт в том же каталоге, и набор проекта нужен ему ровно
        // так же, как исходному разговору: иначе после «чистой сессии» правила и
        // скиллы молча переставали действовать.
        activateGroupsQuietly(
          { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
          cwd,
          (error) => app.log.warn({ err: error }, 'group activation failed'),
        );

        return provider.id === 'claude'
          ? startClaude(nextId, prompt, cwd)
          : startForeign(nextId, prompt, cwd);
      },
    });

    /** Прогон Claude — тот же путь, что и у обычной отправки в чат проекта. */
    function startClaude(nextId: string, prompt: string, cwd: string): boolean {
      const settings = ctx.store.getSettings();
      // Обе инициативы, общей склейкой: этап закроется и в продолжении, а если
      // в новой сессии задачи опять разойдутся — их будет кому развести. Брать
      // здесь только «свою» значило бы, что после первого же продолжения
      // разделение задач молча перестаёт работать.
      const initiative = initiativePrompt(settings);
      // Тумблеры закрытого разговора — новому (см. планировщик выше).
      deps.session.inherit(aliasesOf(chatId, sessionId), nextId);
      // Назначение переезжает на продолжение — ДО запуска, как и при разделении:
      // без записи цепочка глубже одного звена съехала бы на дефолт (второе
      // продолжение уже не знало бы, чем ведётся работа). Заводим только там,
      // где связь была: у обычного разговора наследовать нечего.
      if (assigned) {
        ctx.store.setChatLink(nextId, { ...assigned, createdAt: new Date().toISOString() });
      }
      return deps.runs.start(
        nextId,
        {
          prompt,
          cwd,
          command: activeCliCommand(ctx.store),
          // Пусто в запросе — берём назначение закрываемого разговора, и только
          // потом настройку. Панель модель шлёт всегда, телефон и API-клиенты —
          // нет, и без этой ступени их продолжение уезжало бы на другой модели,
          // чем шла работа.
          model: model || assigned?.model || settings.chatModel,
          effort: effort || assigned?.effort || settings.chatEffort,
          permissionMode: allowEdits ? 'acceptEdits' : 'default',
          permissionPrompt: { runId: nextId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
          ...(initiative ? { appendSystemPrompt: initiative } : {}),
        },
        { projectPath: cwd },
      );
    }

    /** Разговор чужого CLI: свой идентификатор выдаёт его собственное хранилище. */
    function startForeign(nextId: string, prompt: string, cwd: string): boolean {
      const appData = ctx.location.paths.appData;
      const created = createChat(appData, provider.id, { title: nextId, workdir: cwd });
      if (!created) return false;
      // У чужого CLI инициатива — первая реплика переписки, а не флаг запуска:
      // без неё продолжение вело бы себя не так, как обычный чат того же CLI.
      const initiative = initiativePrompt(ctx.store.getSettings(), { foreign: true });
      const outcome = deps.providerChats.send(
        appData,
        provider.id,
        created.id,
        { text: prompt },
        {
          provider,
          models: ctx.models.current(provider.modelVendors ?? []).models,
          ...(initiative ? { systemPrefix: initiative } : {}),
        },
      );
      return outcome.ok;
    }
  });

  /**
   * Тумблер автопродолжения этого разговора. Живёт на сервере, а не в браузере:
   * решение продолжать принимается в момент, когда вкладки может не быть вовсе.
   */
  app.post<{ Body: { chatId?: string; sessionId?: string; enabled?: boolean } }>(
    '/api/chat/handoff/auto',
    async (request, reply) => {
      const { chatId, sessionId, enabled } = request.body ?? {};
      const aliases = aliasesOf(chatId, sessionId);
      if (aliases.length === 0) return reply.code(400).send({ message: 'Не указан разговор' });

      deps.chains.setAuto(aliases, enabled === true);
      return { auto: deps.chains.isAuto(aliases), depth: deps.chains.depth(aliases) };
    },
  );

  /** Состояние цепочки — им восстанавливается тумблер после перезагрузки вкладки. */
  app.get<{ Querystring: { chatId?: string; sessionId?: string } }>(
    '/api/chat/handoff/state',
    (request) => {
      const aliases = aliasesOf(request.query.chatId, request.query.sessionId);
      return {
        auto: deps.chains.isAuto(aliases),
        depth: deps.chains.depth(aliases),
        maxChain: HANDOFF_MAX_CHAIN,
      };
    },
  );

  /**
   * Просьба закрыть этап, посланная кнопкой, а не инициативой агента. Текст
   * живёт на сервере по той же причине, что и системная строка: он описывает
   * ФОРМАТ ответа и порядок уборки, и второй его копии в клиенте быть не должно.
   */
  app.get('/api/chat/handoff/request', () => ({
    prompt:
      'Заверши текущий этап и подготовь продолжение в чистой сессии. ' + HANDOFF_SYSTEM_PROMPT,
  }));
}
