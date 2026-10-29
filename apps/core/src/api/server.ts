import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { commandsInFlight, processCommand, type CommandResult } from '../conductor/commands.ts';
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
import { apiError, commandStatus } from './errors.ts';
import { followTask, lastEventId, openSse } from './sse.ts';

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
  tokens: TokenSources;
  nonces: NonceStore;
  peer: PeerDeps;
  signature: SignatureDeps;
  health: HealthInfo;
  now: () => number;
  pingMs?: number;
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
    return {
      ok: true,
      ...deps.health,
      uptimeMs: deps.now() - deps.health.startedAt,
      liveTasks: live.length,
      queue: { commandsInFlight: commandsInFlight(), commandsPending: pending },
      // Окно лимитов судит `economy/window` (03) — его в ядре ещё нет: названо, а не нуль.
      window: { unknown: 'economy/window not built yet (phase 5)' },
      // Отставание журнала — самая старая строка без fsync по всем живым задачам (07).
      journalLagMs: Math.max(0, ...live.map((t) => t.journalLagMs())),
    };
  });

  app.get('/v1/tasks', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    return { tasks: deps.registry.list() };
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    const { id } = request.params;
    if (!isUuidv7(id)) return reply.code(400).send(apiError('bad-id', 'id задачи — UUIDv7'));
    try {
      const state = deps.registry.view(id);
      if (!state) return reply.code(404).send(apiError('no-task', 'Задачи нет'));
      return { task: state, live: Boolean(deps.registry.live(id)) };
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

  // Маршруты моделей (11 §Phases): адрес занят заранее, наполнение — шаг маршрутов. Значения
  // доступа эта ручка не отдаёт никогда — только виды и наличие.
  app.get('/v1/routes', async (request, reply) => {
    if (!requireRead(request, reply)) return reply;
    return reply
      .code(501)
      .send(apiError('not-implemented', 'Маршруты появятся с реестром маршрутов'));
  });

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
    const refused = await refuseBeforeOpen(deps.registry, command, token, proofOnce);
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
    return send(await processCommand(opened.task, command, proofOnce));
  });

  return app;
}
