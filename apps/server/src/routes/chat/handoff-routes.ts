import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppSettings } from '@agentdeck/contracts';
import {
  HANDOFF_BLOCK_LANG,
  HANDOFF_DEFAULT_CHECKPOINT,
  HANDOFF_MAX_CHAIN,
  HANDOFF_SYSTEM_PROMPT,
  parseHandoffProposal,
  scanHandoffBlocks,
  scanHandoffProse,
  type HandoffProposal,
} from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent } from '../../domains/chat/ChatRunner.ts';
import type { ChatRunRegistry, RunFinished } from '../../domains/chat/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import { planContextRotation } from '../../domains/chat/context-rotation.ts';
import { activateGroupsQuietly } from '../../domains/group-activation.ts';
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
} from '../../domains/chat/ChatHandoff.ts';
import { readChatMessages } from '../../domains/chat/ChatHistory.ts';
import { projectsDir } from './paths.ts';
import { planCascadeStage, stageAppendPrompt } from '../../domains/chat/ChatCascadeStages.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { TreeStartGate } from '../../domains/chat/tree-pause.ts';
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
  /**
   * Пауза дерева. Спрашивается перед КАЖДЫМ автостартом планировщика: дерево,
   * остановленное человеком, не должно само заводить продолжения и звенья —
   * иначе «Остановить всё» держится ровно до конца ближайшего прогона. Нет —
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
  carryLink?: (from: string[], to: string) => void;
  /**
   * Конвейер подбора модели: чем платится понижение. Нет поля — звеньев ревью и
   * правок не бывает вовсе, и всё ведёт себя как до этапа 2.
   */
  cascade?: CascadeStageDeps;
  /**
   * Конвейер уровней разделения (Т1): итог разбора применяется к записи, конец
   * цепочки группы запускает тех, кто её ждал. Нет поля — уровней нет.
   */
  split?: SplitStageDeps;
  /**
   * Ревью по ссылке (Т7): замечания из ответа — в связь, карточка решения —
   * человеку. Нет поля — ревью по ссылкам в этой сборке нет.
   */
  review?: SplitReviewDeps;
  /** Время правки файла; подменяется в тестах. */
  stat?: StatFile;
  /** Отпечаток файла; подменяется в тестах вместе с `stat`. */
  hash?: HashFile;
}

/** Чем планировщик отвечает домену ревью по ссылке (Т7). */
export interface SplitReviewDeps {
  /** Прогон ревью-группы (или правок по нему) кончился: что сказать человеку. */
  onReviewFinished: (input: {
    chatId: string;
    aliases: string[];
    link: ChatLink;
    ok: boolean;
    text: string;
  }) => ChatEvent | undefined;
}

/** Чем планировщик отвечает конвейеру уровней разделения (Т1). */
export interface SplitStageDeps {
  /** Чат разбора кончился: применить блок, завести порцию; событие — в ленту разбора. */
  onTriageFinished: (finished: RunFinished, aliases: string[]) => ChatEvent | undefined;
  /** Цепочка группы (работа → ревью → правки) кончилась; `ok` — без ошибки и остановки. */
  onChainEnded: (link: ChatLink, ok: boolean) => void;
}

/** Что планировщику нужно снаружи, чтобы завести звено конвейера. */
export interface CascadeStageDeps {
  /** Связь закончившегося чата — по любому из его ключей. */
  linkOf: (aliases: string[]) => ChatLink | undefined;
  /** Записать связь нового звена. Строго ДО запуска (см. `SplitLink`). */
  saveLink: (chatId: string, link: ChatLink) => void;
  /** Отметить работу проверенной — по всем ключам чата, чтобы не завести второе ревью. */
  markReviewed: (aliases: string[], at: string) => void;
  /** Отметить план отработанным (Т1) — по всем ключам чата, чтобы не завести вторую работу. */
  markPlanned?: (aliases: string[], at: string) => void;
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
  gate,
  session,
  selfBaseUrl,
  contextLimit,
  carryLink,
  cascade,
  split,
  review,
  stat,
  hash,
}: HandoffPlannerDeps): (finished: RunFinished) => ChatEvent | undefined {
  /**
   * Звено конвейера подбора модели: проверка работы на потолке и правки по её
   * замечаниям. Считается ПОСЛЕ продолжения в чистой сессии и только когда то не
   * состоялось — предложение агента сильнее: оно означает, что работа ещё идёт,
   * а проверять надо законченное.
   */
  function planStage(finished: RunFinished, aliases: string[]): ChatEvent | undefined {
    if (!cascade || !finished.projectPath) return undefined;
    // Звенья номер шага не двигают (см. `HandoffChains.link`), но цепочка,
    // дошедшая до потолка продолжениями, и проверок больше не заводит: потолок —
    // предохранитель от ночи впустую, а не только от одного вида прогонов.
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
    // План отработан ровно один раз: второе сообщение человека в чат плана без
    // отметки заводило бы вторую работу той же группы (Т1).
    if (plan.stage === 'work') cascade.markPlanned?.(aliases, new Date().toISOString());

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
    const chainDepth = chains.link(aliases, chatId, { stage: true });
    // Правки идут ниже потолка так же, как работа, — значит и в журнал сдачи
    // попадают так же. Ревью в него не попадает: оно идёт НА потолке, понижать
    // там нечего и оплачивать нечем.
    const meta = {
      projectPath: cwd,
      // Работа после плана (Т1) понижена так же, как работа из разделения, — и
      // в журнал сдачи попадает так же.
      ...(plan.stage === 'fix' || (plan.stage === 'work' && plan.link.lowered)
        ? {
            lowered: {
              model: plan.model,
              effort: plan.effort,
              ...(link?.kind ? { kind: link.kind } : {}),
            },
          }
        : {}),
    };
    // Дерево на паузе — звено заведено (связь записана), но не запущено:
    // ляжет в очередь и стартует по «Продолжить всё».
    const deferred = gate?.defer('stage', chatId, options, meta) ?? false;
    if (!deferred && !runs.start(chatId, options, meta)) return undefined;

    return {
      kind: 'handoff',
      chatId,
      path: cwd,
      chainDepth,
      stage: plan.stage,
      ...(plan.findings ? { findings: plan.findings } : {}),
      ...(plan.planMissing ? { planMissing: true } : {}),
      ...(deferred ? { deferred: true } : {}),
    };
  }

  return (finished) => {
    const aliases = aliasesOf(finished.chatId, finished.sessionId);
    // Разбор (уровень 1, Т1) — не работа: ни продолжений, ни звеньев у него не
    // бывает, его итог применяет конвейер разделения. Проверяется первым, чтобы
    // блок продолжения в ответе разбора не завёл чистую сессию.
    const link = cascade?.linkOf(aliases);
    if (split && link?.stage === 'triage') return split.onTriageFinished(finished, aliases);

    // Блок сильнее прозы: он называет, что закрыто и чем продолжить. Проза —
    // «перезапустите сессию», «/clear», «продолжай по .agent/PROGRESS.md» —
    // раньше была концом работы до утра; теперь это то же предложение с
    // файлом-опорой из текста, и дальше его ждут те же предохранители.
    const own =
      scanHandoffBlocks(finished.text).proposals.at(-1) ?? scanHandoffProse(finished.text);

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
      ...(chains.lastCheckpointHash(aliases) !== undefined
        ? { previousHash: chains.lastCheckpointHash(aliases) as string }
        : {}),
      ...(stat ? { stat } : {}),
      ...(hash ? { hash } : {}),
    });

    if (!verdict.ok) {
      // Продолжения не будет — значит работа закончена, и настал черёд конвейера.
      // Порядок именно такой: предложение агента означает, что он ещё в работе,
      // и проверять на этом месте было бы нечего.
      const staged = planStage(finished, aliases);
      if (staged) return staged;
      // Ревью чужого MR (Т7): звена после него не бывает — замечания ложатся в
      // связь, а дальше ждут человека. Считается ДО конца цепочки, чтобы хаб
      // показал карточку вместе с закрытием группы, а не следующим ходом.
      const reviewed = link
        ? review?.onReviewFinished({
            chatId: finished.chatId,
            aliases,
            link,
            ok: finished.ok,
            text: finished.text,
          })
        : undefined;
      // Звена нет и продолжения нет — цепочка группы кончилась: конвейер уровней
      // отпускает тех, кто её ждал. План и разбор цепочкой не считаются: за
      // планом работа заводится всегда, а разбор обработан выше.
      if (split && link && link.stage !== 'plan' && link.stage !== 'triage') {
        split.onChainEnded(link, finished.ok);
      }
      // Карточка сильнее отказа продолжения: человеку важно, что ревью
      // кончилось и чем, а не то, что блока продолжения в ответе не было.
      if (reviewed) return reviewed;

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
      // Исходное задание цепочки — задание прогона, который её начал: у ребёнка
      // разделения это задание группы целиком, у обычного разговора — реплика
      // человека. Продолжение своё не перебивает: наследство сильнее.
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
        // Дерево на паузе — продолжение заведено, но не запущено: в очередь.
        if (gate?.defer('handoff', chatId, options, { projectPath: cwd })) {
          deferred = true;
          return false;
        }
        return runs.start(chatId, options, { projectPath: cwd });
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
    };
  }>('/api/chat/:id/restart', async (request, reply) => {
    const chatId = request.params.id;
    const { projectPath, sessionId, allowEdits, model, effort } = request.body ?? {};
    const fromAliases = aliasesOf(chatId, sessionId);

    if (fromAliases.some((key) => deps.runs.isRunning(key))) {
      return reply.code(409).send({
        message: 'Прогон ещё идёт: дождитесь конца хода или остановите его, потом перезапускайте',
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

    if (!fresh || !target) {
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
    const hash = hashFile(target);
    const started = startHandoff({
      proposal: restartProposal(HANDOFF_DEFAULT_CHECKPOINT),
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

/** Предложение, собранное по кнопке: состояние уже в файле-опоре, задания у панели нет. */
function restartProposal(checkpoint: string): HandoffProposal {
  return {
    done: 'Сессия перезапущена по кнопке',
    next: `Продолжай работу по ${checkpoint}: прочитай файл и делай следующий шаг из «в работе».`,
    checkpoint,
  };
}

/** Просьба по кнопке, когда файл-опора старше последней реплики человека. */
function restartRequestPrompt(checkpoint: string): string {
  return (
    `Обнови ${checkpoint} актуальным состоянием работы и конкретным следующим шагом, затем ` +
    `выведи блок ${HANDOFF_BLOCK_LANG} — панель перезапустит сессию сама. ` +
    HANDOFF_SYSTEM_PROMPT
  );
}

/** Чьё продолжение заводится и с какими правами — общее у карточки и у кнопки перезапуска. */
interface ContinuationSource {
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
 */
function continuationStarter(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: {
    runs: ChatRunRegistry;
    providerChats: ProviderChatService;
    session: ChatSession;
  },
  selfBaseUrl: string,
  source: ContinuationSource,
): HandoffStart {
  const provider = getActiveProvider(ctx.store);
  // Чем ведётся ЗАКРЫВАЕМЫЙ разговор. Продолжение — тот же разговор по смыслу,
  // и модель у него обязана быть та же: чат, заведённый разделением, работает
  // подобранной под его задачу, и «чистая сессия» не повод вернуть его на
  // дефолт из настроек. Ключей у разговора два (временный и `sessionId`) —
  // смотрим оба, связь переезжает на второй.
  const assigned =
    ctx.store.getChatLink(String(source.chatId ?? '')) ??
    (source.sessionId ? ctx.store.getChatLink(source.sessionId) : undefined);

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
        model: source.model || assigned?.model || settings.chatModel,
        effort: source.effort || assigned?.effort || settings.chatEffort,
        permissionMode: source.allowEdits ? 'acceptEdits' : 'default',
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

  return ({ chatId: nextId, prompt, cwd }) => {
    // Продолжение идёт в том же каталоге, и набор проекта нужен ему ровно так
    // же, как исходному разговору: иначе после «чистой сессии» правила и скиллы
    // молча переставали действовать.
    activateGroupsQuietly(
      { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
      cwd,
      (error) => app.log.warn({ err: error }, 'group activation failed'),
    );
    return provider.id === 'claude'
      ? startClaude(nextId, prompt, cwd)
      : startForeign(nextId, prompt, cwd);
  };
}
