import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  HANDOFF_DEFAULT_CHECKPOINT,
  HANDOFF_MAX_CHAIN,
  HANDOFF_SYSTEM_PROMPT,
  parseHandoffProposal,
  overflowHandoffProposal,
  restartHandoffProposal,
  restartRequestPrompt,
  scanHandoffBlocks,
  scanHandoffProse,
} from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import type {
  ChatRunRegistry,
  RunFinished,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { initiativePrompt } from '../../domains/chat/initiative/initiative.ts';
import { planContextRotation } from '../../domains/chat/context-rotation/context-rotation.ts';
import { AUTONOMOUS_PERMISSION_MODE } from '../../domains/chat/ChatWorkspace/ChatWorkspace.ts';
import {
  activateGroupsQuietly,
  groupsActivatedNotice,
} from '../../domains/group-activation/group-activation.ts';
import {
  checkpointInside,
  evaluateHandoff,
  hashFile,
  startHandoff,
  statMtime,
  type HandoffChains,
  type HandoffStart,
  type HashFile,
  type StatFile,
} from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { readChatMessages } from '../../domains/chat/ChatHistory/ChatHistory.ts';
import { projectsDir } from './paths.ts';
import { continuationLink } from '../../lib/app-store/chat-links.ts';
import type { TreeStartGate } from '../../domains/chat/tree-pause/tree-pause.ts';
import type { CoreChatPort } from '../../domains/chat/core-run/core-run.types.ts';
import {
  startCoreForeignChat,
  withRoutes,
} from '../../domains/chat/core-foreign/core-foreign-start.ts';
import type { ForeignCarryResolver } from '../../domains/chat/core-foreign/foreign-carry.ts';
import { coreContourRoutes } from '../../domains/platform/routing/core-contour.ts';
import { checkProjectDir } from '../../domains/projects/projects.ts';
import { getActiveProvider, getActiveProviderId } from '../../providers/registry.ts';
import { supportsCliAutoMode } from '../../providers/auto-mode/auto-mode.ts';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';

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
 *
 * Звенья групп разделения (ревью, правки, доставка, шаги «Пути», продолжение той же
 * сессией) ушли вместе со старым рантаймом групп (этап 10, F5): задачу до MR ведёт
 * ядро (`apps/core`), а здесь остаётся продолжение обычного чата панели — пока его
 * прогоны идут через реестр панели.
 */

/** Оба написания ключа одного разговора, без пустых. */
function aliasesOf(chatId?: string, sessionId?: string): string[] {
  return [chatId, sessionId].filter((value): value is string => Boolean(value));
}

export interface HandoffPlannerDeps {
  runs: ChatRunRegistry;
  chains: HandoffChains;
  /**
   * Пауза дерева. Спрашивается перед КАЖДЫМ автостартом планировщика: дерево,
   * остановленное человеком, не должно само заводить продолжения — иначе
   * «Остановить всё» держится ровно до конца ближайшего прогона. Нет —
   * автостарты идут как шли.
   */
  gate?: TreeStartGate;
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
  carryLink?: (from: string[], to: string, prompt?: string) => void;
  /** Время правки файла; подменяется в тестах. */
  stat?: StatFile;
  /** Отпечаток файла; подменяется в тестах вместе с `stat`. */
  hash?: HashFile;
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
  gate,
  session,
  selfBaseUrl,
  contextLimit,
  carryLink,
  stat,
  hash,
}: HandoffPlannerDeps): (finished: RunFinished) => ChatEvent | undefined {
  return (finished) => {
    // Оборванный ход (WP1c) не решает ничего: ответа нет, продолжать нечего.
    if (finished.interrupted) return undefined;
    const aliases = aliasesOf(finished.chatId, finished.sessionId);

    // Блок сильнее прозы: он называет, что закрыто и чем продолжить. Проза —
    // «перезапустите сессию», «/clear», «продолжай по .agent/PROGRESS.md» —
    // раньше была концом работы до утра; теперь это то же предложение с
    // файлом-опорой из текста, и дальше его ждут те же предохранители.
    const block = scanHandoffBlocks(finished.text).proposals.at(-1);
    const own = block ?? scanHandoffProse(finished.text);

    // Второй повод продолжить — размер окна. Предложение агента его перебивает:
    // оно знает, ЧТО закрыто, а порог знает только «сколько накопилось».
    const rotation = planContextRotation({
      contextTokens: finished.contextTokens,
      limit: contextLimit?.() ?? 0,
      hasProposal: Boolean(own),
      ok: finished.ok,
      hasProject: Boolean(finished.projectPath),
    });
    // Закрытое предложение (`closed`, L7.2) повод по порогу не перебивает:
    // `evaluateHandoff` отвечает на него как на ответ без блока.
    const proposal = own ?? (rotation.kind === 'propose' ? rotation.proposal : undefined);

    const verdict = evaluateHandoff({
      ...(proposal ? { proposal } : {}),
      ...(finished.projectPath ? { cwd: finished.projectPath } : {}),
      ok: finished.ok,
      startedAt: finished.startedAt,
      auto: chains.isAuto(aliases),
      depth: chains.depth(aliases),
      ...(chains.lastCheckpointHash(aliases) !== undefined
        ? { previousHash: chains.lastCheckpointHash(aliases) as string }
        : {}),
      ...(stat ? { stat } : {}),
      ...(hash ? { hash } : {}),
    });

    if (!verdict.ok) {
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
    const target = checkpointInside(cwd, verdict.proposal.checkpoint);
    const checkpointHash = target ? (hash ?? hashFile)(target) : undefined;
    let deferred = false;
    const started = startHandoff({
      proposal: verdict.proposal,
      cwd,
      fromAliases: aliases,
      chains,
      startRun: true,
      // Исходное задание цепочки — реплика человека, начавшая её; продолжение
      // своё не перебивает.
      ...(finished.options.prompt ? { rootTask: finished.options.prompt } : {}),
      ...(checkpointHash ? { checkpointHash } : {}),
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
        // Тумблеры — тоже от закрытого разговора:
        // системная дописка скопирована с его состоянием, а автоподтверждение
        // без наследования встало бы на первом же запросе прав, пока человека
        // нет у панели, — ради чего цепочка и заводилась.
        session.inherit(aliases, chatId);
        // Связь — тоже от закрытого разговора, и строго ДО запуска: перенос на
        // настоящий `sessionId` ищет запись по временному ключу и, не найдя,
        // молча ничего не делает.
        carryLink?.(aliases, chatId, prompt);
        // Происхождение — тоже от закрытого прогона: продолжение в чистой
        // сессии остаётся тем же потребителем контура, что и работа до него.
        const meta = {
          projectPath: cwd,
          ...(finished.origin ? { origin: finished.origin } : {}),
        };
        // Дерево на паузе — продолжение заведено, но не запущено: в очередь.
        if (gate?.defer('handoff', chatId, options, meta)) {
          deferred = true;
          return false;
        }
        return runs.start(chatId, options, meta);
      },
    });

    return {
      kind: 'handoff',
      chatId: started.chatId,
      path: started.path,
      chainDepth: started.chainDepth,
      ...(rotation.kind === 'propose' ? { contextTokens: rotation.contextTokens } : {}),
      ...(deferred ? { deferred: true } : {}),
    };
  };
}

export function registerChatHandoffRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: {
    runs: ChatRunRegistry;
    chains: HandoffChains;
    /** Разговор чужого CLI заводится задачей ядра (`startCoreForeignChat`). */
    coreChats: Pick<CoreChatPort, 'estimate' | 'command'>;
    /** Слой панели разговору чужого CLI (G6): строка о тестах, набор для CLI. */
    foreignCarry?: ForeignCarryResolver;
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
      return reply.code(400).send({
        message: 'Предложение не разобрано: нужны «что закрыто» и «чем продолжить»',
        messageCode: 'handoff-proposal-invalid',
      });
    }

    const fromAliases = aliasesOf(chatId, sessionId);
    // Отпечаток файла-опоры сейчас: следующее продолжение сравнит с ним свой и
    // поймёт, что агент ходит по кругу. Ручной шаг сам по себе не проверяется.
    const target = checkpointInside(dir, proposal.checkpoint);
    const checkpointHash = target ? hashFile(target) : undefined;

    return startHandoff({
      proposal,
      cwd: dir,
      fromAliases,
      chains: deps.chains,
      startRun: startRun !== false,
      ...(checkpointHash ? { checkpointHash } : {}),
      start: continuationStarter(app, ctx, deps, selfBaseUrl, {
        fromAliases,
        ...(chatId ? { chatId } : {}),
        ...(sessionId ? { sessionId } : {}),
        allowEdits: allowEdits === true,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    });
  });

  /**
   * Кнопка «Перезапустить сессию» в меню шапки: человек хочет чистую сессию СЕЙЧАС,
   * не дожидаясь, пока агент сам предложит. Три исхода:
   *
   * - прогон идёт → 409: стирать контекст посреди хода — потерять ход;
   * - файл-опора свежее последней реплики человека → продолжение заводится сразу,
   *   как по карточке (текущее состояние уже записано);
   * - файл-опора старше → агенту уходит просьба обновить его и выдать блок, а
   *   автопродолжение разговора включается: следующий конец хода панель
   *   доведёт до чистой сессии сама. Отвечаем текстом просьбы — её отправляет
   *   вкладка обычным сообщением, теми же моделью и правами, что и всё остальное.
   */
  app.post<{
    Params: { id: string };
    Body: {
      projectPath?: string;
      sessionId?: string;
      allowEdits?: boolean;
      model?: string;
      effort?: string;
      /**
       * Контекст переполнен («Prompt is too long»): просьбу обновить опору
       * разговор не примет, продолжение заводится сразу.
       */
      overflow?: boolean;
    };
  }>('/api/chat/:id/restart', async (request, reply) => {
    const chatId = request.params.id;
    const { projectPath, sessionId, allowEdits, model, effort, overflow } = request.body ?? {};
    const fromAliases = aliasesOf(chatId, sessionId);

    if (fromAliases.some((key) => deps.runs.isRunning(key))) {
      return reply.code(409).send({
        message: 'Прогон ещё идёт: дождитесь конца хода или остановите его, потом перезапускайте',
        messageCode: 'restart-run-in-progress',
      });
    }
    const problem = checkProjectDir(String(projectPath ?? ''));
    if (problem) return reply.code(400).send({ message: problem });
    const dir = resolve(projectPath as string);

    // Свежесть — относительно последней реплики человека: всё, что агент записал
    // после неё, записано в этом разговоре. Разговор без транскрипта (черновик
    // под временным ключом) считается несвежим: сравнивать не с чем.
    const recent = sessionId
      ? await readChatMessages(projectsDir(ctx), sessionId, { limit: 40 })
      : undefined;
    const humans = (recent?.messages ?? []).filter((message) => message.role === 'user');
    const lastHuman = humans.at(-1);
    const lastTurnAt = lastHuman ? Date.parse(lastHuman.timestamp) : Number.NaN;
    const target = checkpointInside(dir, HANDOFF_DEFAULT_CHECKPOINT);
    const mtime = target ? statMtime(target) : undefined;
    const fresh = mtime !== undefined && Number.isFinite(lastTurnAt) && mtime >= lastTurnAt;

    if (!overflow && (!fresh || !target)) {
      deps.chains.setAuto(fromAliases, true);
      return {
        mode: 'requested' as const,
        prompt: restartRequestPrompt(HANDOFF_DEFAULT_CHECKPOINT),
      };
    }

    const lastHumanText = (lastHuman?.blocks ?? [])
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    const hash = target ? hashFile(target) : undefined;
    const started = startHandoff({
      proposal: overflow
        ? overflowHandoffProposal(HANDOFF_DEFAULT_CHECKPOINT)
        : restartHandoffProposal(HANDOFF_DEFAULT_CHECKPOINT),
      cwd: dir,
      fromAliases,
      chains: deps.chains,
      startRun: true,
      ...(lastHumanText ? { rootTask: lastHumanText } : {}),
      ...(hash ? { checkpointHash: hash } : {}),
      start: continuationStarter(app, ctx, deps, selfBaseUrl, {
        fromAliases,
        chatId,
        ...(sessionId ? { sessionId } : {}),
        allowEdits: allowEdits === true,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    });
    return { mode: 'started' as const, ...started };
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
      if (aliases.length === 0)
        return reply
          .code(400)
          .send({ message: 'Не указан разговор', messageCode: 'conversation-unspecified' });

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
      'Close the current stage and prepare the continuation in a clean session. ' +
      HANDOFF_SYSTEM_PROMPT,
  }));
}

/** Чьё продолжение заводится и с какими правами — общее у карточки и у кнопки перезапуска. */
export interface ContinuationSource {
  /** Ключи закрываемого разговора — тумблеры прав наследуются по ним. */
  fromAliases: string[];
  chatId?: string;
  sessionId?: string;
  allowEdits: boolean;
  model?: string;
  effort?: string;
}

/**
 * Запуск продолжения в том же каталоге — у карточки и у кнопки перезапуска один
 * и тот же: два пути к «новому разговору того же проекта» разошлись бы на первой
 * же правке (набор проекта, наследование модели, инициативы).
 *
 * Отдан наружу ради переноса незакрытой работы (П6.1): у него тот же вопрос —
 * «открой разговор в этом каталоге у активного провайдера», — и собственная
 * копия наследования прав, модели и набора проекта разошлась бы с этой.
 */
export function continuationStarter(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: {
    runs: ChatRunRegistry;
    coreChats: Pick<CoreChatPort, 'estimate' | 'command'>;
    foreignCarry?: ForeignCarryResolver;
    session: ChatSession;
  },
  selfBaseUrl: string,
  source: ContinuationSource,
): HandoffStart {
  const provider = getActiveProvider(ctx.store);
  // Чем ведётся ЗАКРЫВАЕМЫЙ разговор. Продолжение — тот же разговор по смыслу,
  // и модель у него обязана быть та же: «чистая сессия» не повод вернуть его на
  // дефолт из настроек. Ключей у разговора два (временный и `sessionId`) —
  // смотрим оба, связь переезжает на второй.
  const assigned =
    ctx.store.getChatLink(String(source.chatId ?? '')) ??
    (source.sessionId ? ctx.store.getChatLink(source.sessionId) : undefined);
  // Откуда прогон для контура (Т3). Прогона, от которого заводится продолжение,
  // в реестре может уже не быть (кнопку перезапуска жмут и через час), поэтому
  // источник берём долговечный: разговор со связью — ребёнок в дереве, и его
  // продолжение спрашивает маршрут тем же потребителем, что его первый ход
  // (`run-routes.ts`), а не «Чат».
  const origin = assigned ? ('groups' as const) : undefined;

  /** Прогон Claude — тот же путь, что и у обычной отправки в чат проекта. */
  function startClaude(nextId: string, prompt: string, cwd: string): boolean {
    const settings = ctx.store.getSettings();
    // Обе инициативы, общей склейкой: этап закроется и в продолжении, а если
    // в новой сессии задачи опять разойдутся — их будет кому развести. Брать
    // здесь только «свою» значило бы, что после первого же продолжения
    // разделение задач молча перестаёт работать.
    const initiative = initiativePrompt(settings);
    // Тумблеры закрытого разговора — новому (см. планировщик).
    deps.session.inherit(source.fromAliases, nextId);
    // Назначение переезжает на продолжение — ДО запуска: без записи цепочка
    // глубже одного звена съехала бы на дефолт (второе продолжение уже не знало
    // бы, чем ведётся работа). Заводим только там, где связь была: у обычного
    // разговора наследовать нечего.
    if (assigned) {
      ctx.store.setChatLink(nextId, continuationLink(assigned, prompt));
    }
    // Пусто в запросе — берём назначение закрываемого разговора, и только
    // потом настройку. Панель модель шлёт всегда, телефон и API-клиенты —
    // нет, и без этой ступени их продолжение уезжало бы на другой модели,
    // чем шла работа.
    const model = source.model || assigned?.model || settings.chatModel;
    // Продолжение обычного чата — тот же разговор, и авторежим у него тот же,
    // что при отправке (`run-routes.ts`): выбор человека в чате сильнее
    // глобальной настройки; у модели без авторежима CLI — `acceptEdits`, рутину
    // снимет автоподтверждение, унаследованное строкой выше.
    const cliAutoMode =
      (deps.session.autoModeOverride(...source.fromAliases) ?? settings.chatAutoMode) &&
      supportsCliAutoMode(getActiveProviderId(ctx.store), model);
    return deps.runs.start(
      nextId,
      {
        prompt,
        cwd,
        // Команда — от того же снимка провайдера, по которому выбрана эта ветка
        // (`provider.id === 'claude'` ниже), а не от настройки заново: иначе
        // переключение CLI между ними дало бы чужой бинарь с флагами Claude.
        command: providerCliCommand(provider),
        model,
        effort: source.effort || assigned?.effort || settings.chatEffort,
        permissionMode: source.allowEdits
          ? cliAutoMode
            ? AUTONOMOUS_PERMISSION_MODE
            : 'acceptEdits'
          : 'default',
        permissionPrompt: { runId: nextId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
        ...(initiative ? { appendSystemPrompt: initiative } : {}),
      },
      { projectPath: cwd, ...(origin ? { origin } : {}) },
    );
  }

  /**
   * Разговор чужого CLI — задача ядра `chat@1` с этим CLI (этап 10, F2c): своего исполнителя
   * чужих CLI у панели больше нет. Ответ «заведено» синхронный, как у Claude выше (реестр тоже
   * отвечает до первого события): ядро зовётся следом, его отказ — с кодом в журнал сервера,
   * а задача, которую ядро успело завести, остаётся в его ленте со своим состоянием.
   */
  function startForeign(prompt: string, cwd: string, title?: string): boolean {
    // Имя, а не ключ: ключ вида `new-1758…` в ленте задач читался бы как название.
    // У чужого CLI инициатива — первая реплика, а не флаг запуска (`preface`).
    const initiative = initiativePrompt(ctx.store.getSettings(), { foreign: true });
    const model = source.model || assigned?.model;
    // Галочка контура `foreign:<cli>` — тот же маршрут, что у прежнего исполнителя панели.
    const routes = withRoutes(
      coreContourRoutes(ctx.store, `foreign:${provider.id}`, provider.id, model ?? ''),
    );
    // Слой панели (G6): строка о тестах и набор для CLI; не переносится — разговор не заводится.
    const carried = deps.foreignCarry?.({ cli: provider.id, cwd, ...routes });
    if (carried && !carried.ok) {
      app.log.warn({ cli: provider.id }, `foreign continuation: ${carried.reason}`);
      return false;
    }
    void startCoreForeignChat(deps.coreChats, {
      cli: provider.id,
      cwd,
      prompt,
      title: title ?? 'Продолжение',
      ...(model ? { model, effort: source.effort || assigned?.effort } : {}),
      ...(initiative ? { preface: initiative } : {}),
      ...routes,
      ...(carried ? { carry: carried.carry } : {}),
    })
      .then((outcome) => {
        if (!outcome.ok) {
          app.log.warn(
            { code: outcome.code, cli: provider.id },
            `foreign continuation refused by the core: ${outcome.message}`,
          );
        }
      })
      .catch((error: unknown) =>
        app.log.warn({ err: error, cli: provider.id }, 'foreign continuation: core unreachable'),
      );
    return true;
  }

  return ({ chatId: nextId, prompt, cwd, title }) => {
    // Продолжение идёт в том же каталоге, и набор проекта нужен ему ровно так
    // же, как исходному разговору: иначе после «чистой сессии» правила и скиллы
    // молча переставали действовать. Тумблер каталогов — только у Claude: чужой
    // CLI файлов Claude не читает, привязанные группы он получает слоем на
    // прогон при отправке (`group-activation-wiring`), а `~/.claude` не трогается.
    const activated =
      provider.id === 'claude'
        ? activateGroupsQuietly(
            { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
            cwd,
            (error) => app.log.warn({ err: error }, 'group activation failed'),
          )
        : [];
    const started =
      provider.id === 'claude'
        ? startClaude(nextId, prompt, cwd)
        : startForeign(prompt, cwd, title);
    // Заметка — ПОСЛЕ старта: до него прогона в реестре нет, и сказать некуда.
    // У чужого CLI его нет вовсе — `emitExternal` отвечает «некуда», и факт
    // остаётся на странице «Наборы».
    const notice = started ? groupsActivatedNotice(activated) : undefined;
    if (notice) deps.runs.emitExternal(nextId, notice);
    return started;
  };
}
