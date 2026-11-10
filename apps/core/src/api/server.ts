import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import type { HealthReply, TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import type { Route, RoutePrice } from '@agentdeck/contracts/core/routes';
import type { BoardPort } from '../conductor/board/board.types.ts';
import type { InboxPort } from '../conductor/inbox/inbox.types.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import {
  commandsInFlight,
  processCommand,
  type CommandEnv,
  type CommandResult,
} from '../conductor/commands.ts';
import { windowHealth, type WindowBook } from '../economy/window/index.ts';
import { linesAfter } from '../journal/read-view.ts';
import { join } from 'node:path';
import type { CommandProof } from '../policy/authority/authority.ts';
import type { NonceStore } from '../policy/authority/nonce.ts';
import { refuseBeforeOpen } from './command-gate.ts';
import {
  classifyPeer,
  classifyToken,
  createSeenSignatures,
  gatherProof,
  type PeerDeps,
  type SignatureDeps,
  type TokenClass,
  type TokenSources,
} from './auth.ts';
import { registerAgents, type AgentsPort } from './agents.ts';
import { registerAllocator, type AllocatorPort } from './allocator.ts';
import { registerAsk, type AskPort } from './ask.ts';
import { registerLocalActivity, type LocalActivityPort } from './local-activity.ts';
import { registerBoardMove } from './board-move.ts';
import { registerBoardView } from './board-view.ts';
import { registerInbox } from './inbox.ts';
import { registerTaskAttachments } from './attachments.ts';
import { registerReviewLink, type ReviewLinkPort } from './review-link.ts';
import { registerConfig } from './config.ts';
import { registerDevices, type DevicesPort } from './devices.ts';
import { registerLearned, type LearnedPort } from './learned.ts';
import { registerLocalHold, type LocalHoldPort } from './local-hold.ts';
import type { ConfigPort } from './config.types.ts';
import { registerContours, type ContoursPort } from './contours.ts';
import { registerDlpProxy, type DlpProxyPort } from './dlp-proxy.ts';
import { apiError, commandStatus } from './errors.ts';
import { registerEstimate } from './estimate.ts';
import type { RouteContext } from './route-context.types.ts';
import { registerProfiles } from './profiles.ts';
import { registerRecords } from './records.ts';
import { registerReport } from './report.ts';
import { registerWalk } from './walk.ts';
import { registerDelivery } from './delivery.ts';
import { registerMcpOffers, type McpOffersPort } from './mcp-offers.ts';
import { registerRoutesView } from './routes.ts';
import { registerScenarios } from './scenarios.ts';
import { registerSessionStream } from './session-stream.ts';
import type { AdapterRegistry } from '../adapters/index.ts';
import { followTask, lastEventId, openSse } from './sse.ts';
import { priceBookOf, taskViewOf } from './task-view.ts';
import { taskListOf, taskListQuery } from './task-read.ts';

/**
 * HTTP API ядра (07 §API) — только на 127.0.0.1, порт вне 5170–5180 (P59). Каждое чтение —
 * по токену ядра или Bearer панели; токен сессии чтению не годится (сессия видит свою задачу
 * через MCP, фаза 4). Команды — `POST /v1/commands`: разбор (400), задача (404), приём и суд
 * полномочий в дирижёре. Ни одна ручка не отдаёт значение доступа.
 */

export interface HealthInfo {
  build: string;
  bootId: string;
  pid: number;
  startedAt: number;
  home: string;
}

export interface ApiDeps {
  registry: TaskRegistry;
  /**
   * Среда команд и ручек этапа 4: дом ядра и порт среды деления. Загрузка собирает API раньше
   * дирижёра, поэтому `split()` читается в момент команды, а не при сборке.
   */
  env: CommandEnv;
  tokens: TokenSources;
  nonces: NonceStore;
  peer: PeerDeps;
  signature: SignatureDeps;
  health: HealthInfo;
  /** Книга окон ядра (G7) — та же, что пишет проводка экономики: health читает её. */
  windows: WindowBook;
  now: () => number;
  pingMs?: number;
  /** Порт настройки ядра (этап 7, зона настройки); нет — `/v1/config` отвечает 501. */
  config?: () => ConfigPort | undefined;
  /**
   * Цена маршрута для вида задачи (этап 9): чтение реестра маршрутов. Нет — расход показан
   * токенами без цены, а не деньгами по догадке (P127).
   */
  routePrice?: (routeId: string, model: string) => Promise<Fact<RoutePrice>>;
  /** Маршруты этой загрузки для `/v1/routes` (этап 9); нет — 501 «реестр не подключён». */
  routes?: () => readonly Route[] | undefined;
  /** Доверенные звенья пересылки для health (P131): сколько и когда надзор их записал. */
  trustedHops?: () => { count: number; recordedAt: number | null };
  /** Перенос ключей телефона в устройства ядра (G9); нет — `/v1/devices/adopt` отвечает 501. */
  devices?: () => DevicesPort | undefined;
  /** Сброс ключа обучения человеком (этап 11, P140); нет — `/v1/learned/reset` отвечает 501. */
  learned?: () => LearnedPort | undefined;
  /** Реестр переходников загрузки: вид сеанса читает поток их нормализатором (этап 10). */
  adapters?: AdapterRegistry;
  /** Серверы MCP человека по CLI для экрана выбора (s10 p9); нет — `/v1/mcp-offers` отвечает 501. */
  mcpOffers?: () => McpOffersPort | undefined;
  /** Удержание своей модели панелью (этап 10, зона C); нет — `/v1/local/*` отвечает 501. */
  localHold?: () => LocalHoldPort | undefined;
  /** Учёт контуров звена (этап 10, C3b); нет — `/v1/contours*` отвечает 501. */
  contours?: () => ContoursPort | undefined;
  /** Прокси защиты данных человека (C3c); нет — `/v1/dlp-proxy*` отвечает 501. */
  dlpProxy?: () => DlpProxyPort | undefined;
  /** Лёгкая сессия панели (этап 10, F2); нет — `/v1/ask` после суда отвечает 501. */
  ask?: () => AskPort | undefined;
  /** Ревью MR по ссылке (этап 10, F8); нет — `/v1/review-link` после суда отвечает 501. */
  reviewLink?: () => ReviewLinkPort | undefined;
  /** Дерево агентов (этап 11, `bootstrap/agents-wiring`); нет — `/v1/*agents*` отвечает 501. */
  agents?: () => AgentsPort | undefined;
  /** Места сеансов (этап 11, `bootstrap/allocator-wiring`); нет — `/v1/allocator` отвечает 501. */
  allocator?: () => AllocatorPort | undefined;
  /** Управляющий канал хоста звеньев для активности своей модели (этап 11); нет — 501. */
  localActivity?: () => LocalActivityPort | undefined;
  /**
   * Доска задач (этап 12, `bootstrap/board-wiring.ts`). Ручки `/v1/board*` регистрирует зона Z1;
   * нет порта — они отвечают 501.
   */
  board?: () => BoardPort | undefined;
  /**
   * Входящие (этап 12, `bootstrap/inbox-wiring.ts`). Ручки `/v1/inbox*` регистрирует зона Z7;
   * нет порта — они отвечают 501.
   */
  inbox?: () => InboxPort | undefined;
}

const READ_TOKENS: ReadonlySet<TokenClass> = new Set(['core', 'panel-bearer']);

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const seen = createSeenSignatures(deps.now);

  const tokenOf = (request: FastifyRequest): TokenClass =>
    classifyToken(request.headers.authorization, deps.tokens);

  const requireRead = (request: FastifyRequest, reply: FastifyReply): TokenClass | undefined => {
    const token = tokenOf(request);
    if (READ_TOKENS.has(token)) return token;
    void reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    return undefined;
  };

  app.get('/v1/health', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    const live = deps.registry.liveTasks();
    const pending = live.reduce(
      (sum, t) =>
        sum + Object.values(t.state.commands).filter((c) => c.status === 'received').length,
      0,
    );
    const body: HealthReply = {
      ok: true,
      ...deps.health,
      uptimeMs: deps.now() - deps.health.startedAt,
      liveTasks: live.length,
      queue: { commandsInFlight: commandsInFlight(), commandsPending: pending },
      // Окно лимитов судит `economy/window` (03): вердикт на маршрут × вид предела из книги ядра.
      window: windowHealth(deps.windows, deps.now()),
      // Отставание журнала — самая старая строка без fsync по всем живым задачам (07).
      journalLagMs: Math.max(0, ...live.map((t) => t.journalLagMs())),
      // Звенья, которым надзор разрешил пересылать pid (P131); `null` — надзора у загрузки нет.
      trustedHops: deps.trustedHops?.() ?? null,
    };
    return body;
  });

  app.get('/v1/tasks', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    // Тип ответа — контракт панели: строка списка, разошедшаяся с ним, не собирается.
    // `?groupId=` / `?parentTaskId=` (W3-18): задачи группы и дочерние задачи XL.
    const body: TasksReply = { tasks: taskListOf(deps.registry, taskListQuery(request.query)) };
    return body;
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    const { id } = request.params;
    if (!isUuidv7(id)) return reply.code(400).send(apiError('bad-id', 'id задачи — UUIDv7'));
    try {
      const state = deps.registry.view(id);
      if (!state) return reply.code(404).send(apiError('no-task', 'Задачи нет'));
      // Вид для панели — из той же свёртки и строк журнала (P43: расход — только `spendOf`).
      const lines = linesAfter(join(deps.registry.tasksDir, id), id, 0);
      const view = taskViewOf({
        taskId: id,
        state,
        lines,
        priceFor: await priceBookOf(lines, deps.routePrice),
        attention: deps.registry.attentionOf(id),
      });
      const body: TaskReply = { task: state, live: Boolean(deps.registry.live(id)), view };
      return body;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return reply.code(500).send(apiError('journal-unreadable', reason));
    }
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id/events', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    const { id } = request.params;
    let known: boolean;
    try {
      known = isUuidv7(id) && deps.registry.view(id) !== undefined;
    } catch (error) {
      // Журнал задачи, отделённой при загрузке (F-49), не читается: причина, а не общий сбой.
      const reason = error instanceof Error ? error.message : String(error);
      return reply.code(500).send(apiError('journal-unreadable', reason));
    }
    if (!known) return reply.code(404).send(apiError('no-task', 'Задачи нет'));
    const after = lastEventId(request.headers['last-event-id'], request.query);
    reply.hijack();
    const subscription: { off?: () => void } = {};
    const stream = openSse(reply.raw, {
      ...(deps.pingMs ? { pingMs: deps.pingMs } : {}),
      onClose: () => subscription.off?.(),
    });
    const dir = join(deps.registry.tasksDir, id);
    subscription.off = followTask(
      stream,
      {
        live: () => deps.registry.live(id),
        watch: (handlers) => deps.registry.watch(id, handlers),
        linesAfter: (seq) => linesAfter(dir, id, seq),
      },
      after,
    );
    // Клиент ушёл, пока поток читал хвост: отписка, которую `onClose` ещё не мог позвать.
    if (stream.closed) subscription.off();
    return reply;
  });

  // Ручки этапов 4 и 9 живут в своих модулях: здесь только регистрация. Маршруты моделей
  // (11 §Phases) отдают вид и наличие доступа, значение — никогда.
  const routeContext: RouteContext = {
    registry: deps.registry,
    env: deps.env,
    requireRead,
    tokenOf,
    proof: { nonces: deps.nonces, peer: deps.peer, signature: deps.signature, seen },
    now: deps.now,
    ...(deps.adapters ? { adapters: deps.adapters } : {}),
  };
  registerSessionStream(app, routeContext);
  registerEstimate(app, routeContext);
  registerTaskAttachments(app, routeContext);
  registerAsk(app, routeContext, () => deps.ask?.());
  registerReviewLink(app, routeContext, () => deps.reviewLink?.());
  registerScenarios(app, routeContext);
  registerConfig(app, routeContext, () => deps.config?.());
  registerRecords(app, routeContext);
  registerReport(app, routeContext);
  registerWalk(app, routeContext);
  registerDelivery(app, routeContext);
  registerProfiles(app, routeContext);
  registerRoutesView(app, routeContext, () => deps.routes?.());
  registerMcpOffers(app, routeContext, () => deps.mcpOffers?.());
  registerDevices(app, routeContext, () => deps.devices?.());
  registerLearned(app, routeContext, () => deps.learned?.());
  registerLocalHold(app, routeContext, () => deps.localHold?.());
  registerContours(app, routeContext, () => deps.contours?.());
  registerDlpProxy(app, routeContext, () => deps.dlpProxy?.());
  registerAgents(app, routeContext, () => deps.agents?.());
  registerAllocator(app, routeContext, () => deps.allocator?.());
  registerLocalActivity(app, routeContext, () => deps.localActivity?.());
  // Этап 12 (Z1): доска задач — снимок, ход человека, новые записи; нет проводки — 501.
  registerBoardView(app, routeContext, () => deps.board?.());
  registerBoardMove(app, routeContext, () => deps.board?.());
  // Этап 12 (Z7): входящие — поиск по источнику и записи доски из выбранного; нет проводки — 501.
  registerInbox(app, routeContext, () => deps.inbox?.());

  app.get<{ Querystring: { page?: string } }>('/v1/nonce', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    const page = request.query.page;
    if (!page || !isUuidv7(page)) {
      return reply.code(400).send(apiError('bad-page', 'page — UUIDv7 загрузки страницы'));
    }
    // Число страницы — половина доказательства человека: процесс из дерева сессии (прочитал
    // токен ядра) его не получает (ревью F-05, F-15). Пир `unknown` число получает — строгую
    // команду без подписи он всё равно не проведёт (06 §Authority).
    if ((await classifyPeer(request.raw, deps.peer)) === 'session-descendant') {
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Процесс сессии не получает число страницы'));
    }
    return deps.nonces.mint(page);
  });

  app.post('/v1/commands', async (request, reply) => {
    const token = tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const parsed = parseCommand(request.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(apiError('bad-command', 'Команда не прошла разбор', { issues: parsed.issues }));
    }
    const command = parsed.command;
    // Доказательство собирается один раз: суд до открытия и приём в дирижёре видят одно и то же
    // (одноразовое число не сгорает дважды).
    let proof: Promise<CommandProof> | undefined;
    const proofOnce = (): Promise<CommandProof> =>
      (proof ??= gatherProof({
        request: request.raw,
        command,
        token,
        nonces: deps.nonces,
        peer: deps.peer,
        signature: deps.signature,
        seen,
      }));
    const send = (result: CommandResult) =>
      reply.code(result.status === 'applied' ? 200 : commandStatus(result.code)).send(result);
    const refused = await refuseBeforeOpen(
      deps.registry,
      command,
      token,
      proofOnce,
      deps.env.rework ? () => deps.env.rework?.() : undefined,
    );
    if (refused) {
      return 'result' in refused
        ? send(refused.result)
        : reply.code(refused.status).send(refused.error);
    }
    const opened = await deps.registry.open(command.target.taskId);
    if ('refused' in opened) {
      const status = opened.refused === 'no such task' ? 404 : 409;
      return reply.code(status).send(apiError('task-unavailable', opened.refused));
    }
    return send(await processCommand(opened.task, command, proofOnce, deps.env));
  });

  return app;
}
