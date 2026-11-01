import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  inputSchemaOf,
  MODEL_TOOL_DESCRIPTIONS,
  toolPlanFor,
} from '@agentdeck/contracts/core/model-tools';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { handleModelTool } from '../conductor/model-tools/model-tools.ts';
import type {
  ModelToolDeps,
  PermitCallDeps,
  SessionBinding,
} from '../conductor/model-tools/model-tools.types.ts';
import { answerPermitCall } from '../conductor/model-tools/permit-call.ts';
import type { LiveTask } from '../journal/resume.ts';
import type { SessionTokens } from '../policy/session-tokens/session-tokens.ts';
import { bearerOf } from './auth.ts';
import { answerHookCall } from './session-hook.ts';
import type { SessionStatePort } from './session-state.types.ts';
import { apiError } from './errors.ts';

/**
 * Ручки сессии (03 §Model tools): мосты MCP `agentdeck` и `agentdeck-permit` и хук ядра
 * (`run.ts hook`) ходят сюда с токеном СВОЕЙ сессии. Токен ядра и Bearer панели здесь не годятся — это дорога модели, а не
 * человека и не панели; токен сессии, в свою очередь, не годится ни одной ручке человека
 * (`classifyToken` → `session` → отказ полномочий). Сессию называет только токен: задачу и шаг
 * из тела ядро не берёт, поэтому чужой шаг вызовом не достать.
 *
 * Плагин монтирует владелец `api/server.ts`: `registerSessionTools(app, deps)` после
 * `buildApi`, и `isSessionToken: (t) => tokens.verify(t) !== undefined` в источники токенов.
 */

export interface SessionToolsDeps {
  registry: TaskRegistry;
  tokens: SessionTokens;
  tools: ModelToolDeps;
  /** Переходник, кодек и факты копии сессии; нет — вопрос о праве отказывается (fail-closed). */
  permitDeps(task: LiveTask, binding: SessionBinding): PermitCallDeps | undefined;
  /** Документ `agentdeck state` (этап 7, зона состояния); нет — `/v1/session/state` 501. */
  state?: SessionStatePort;
}

type Bound = { task: LiveTask; binding: SessionBinding };

async function bind(
  deps: SessionToolsDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  startingOk = false,
): Promise<Bound | undefined> {
  const token = bearerOf(request.headers.authorization);
  const claim = token ? deps.tokens.verify(token) : undefined;
  if (!claim) {
    void reply.code(401).send(apiError('session-token-required', 'Нужен токен сессии'));
    return undefined;
  }
  const opened = await deps.registry.open(claim.taskId);
  if ('refused' in opened) {
    void reply.code(409).send(apiError('task-unavailable', opened.refused));
    return undefined;
  }
  const bound = bindingOf(opened.task, claim.sessionId);
  if ('refused' in bound) {
    // Токен ядро отчеканило этой сессии, а `session.started` ещё не записан: сессия
    // запускается. Список инструментов CLI спрашивает при старте мостов MCP, раньше, чем запуск
    // вернул pid (Qwen) — это «повтори» (503, мост повторяет), а не отказ: иначе CLI теряет
    // сервер на весь сеанс. Вопрос о праве до записи сессии — по-прежнему отказ (403).
    if (startingOk && bound.refused === 'no-session') {
      void reply
        .code(503)
        .send(apiError('session-starting', 'Сессия ещё запускается — повторите запрос'));
      return undefined;
    }
    void reply.code(403).send(apiError(bound.refused, bound.reason));
    return undefined;
  }
  return { task: opened.task, binding: bound.binding };
}

export function registerSessionTools(app: FastifyInstance, deps: SessionToolsDeps): void {
  app.get('/v1/session/tools', async (request, reply) => {
    const got = await bind(deps, request, reply, true);
    if (!got) return reply;
    const plan = toolPlanFor(got.binding.stepKind);
    return {
      stepKind: got.binding.stepKind,
      builtins: plan?.builtins ?? 'read-only',
      tools: (plan?.modelTools ?? []).map((name) => ({
        name,
        description: MODEL_TOOL_DESCRIPTIONS[name],
        inputSchema: inputSchemaOf(name),
      })),
    };
  });

  // `agentdeck state` (03:82): чтение своей сессии по её токену — только своё, только чтение.
  app.get('/v1/session/state', async (request, reply) => {
    const got = await bind(deps, request, reply);
    if (!got) return reply;
    if (!deps.state) {
      return reply
        .code(501)
        .send(apiError('not-implemented', 'Состояние сессии ещё не подключено'));
    }
    const doc = deps.state.read(got.task, got.binding);
    if ('unknown' in doc) {
      return reply.code(500).send(apiError('state-unreadable', doc.unknown));
    }
    return doc.value;
  });

  app.post<{ Params: { name: string }; Body: { input?: unknown } }>(
    '/v1/session/tools/:name',
    async (request, reply) => {
      const got = await bind(deps, request, reply);
      if (!got) return reply;
      const body = request.body as { input?: unknown } | undefined;
      return handleModelTool(got.task, got.binding, request.params.name, body?.input, deps.tools);
    },
  );

  app.post<{ Body: { raw?: unknown } }>('/v1/session/permit', async (request, reply) => {
    const got = await bind(deps, request, reply);
    if (!got) return reply;
    const permit = deps.permitDeps(got.task, got.binding);
    if (!permit) {
      return reply
        .code(503)
        .send(apiError('permit-unavailable', 'У сессии нет кодека права — вопрос отказан'));
    }
    const body = request.body as { raw?: unknown } | undefined;
    const outcome = await answerPermitCall(got.task, got.binding, body?.raw, permit);
    return { reply: outcome.reply, outcome: outcome.kind };
  });

  // Хук ядра PreToolUse (`run.ts hook`): решение тем же судьёй и теми же фактами сессии, что
  // у сервера права. Неприкреплённая сессия — 503 (хук повторяет, потом отказывает).
  app.post<{ Body: { tool?: unknown; input?: unknown; toolUseId?: unknown } }>(
    '/v1/session/hook',
    async (request, reply) => {
      const got = await bind(deps, request, reply);
      if (!got) return reply;
      const permit = deps.permitDeps(got.task, got.binding);
      if (!permit) {
        return reply
          .code(503)
          .send(apiError('permit-unavailable', 'Сессия не прикреплена — вызов отказан'));
      }
      const body = request.body as
        { tool?: unknown; input?: unknown; toolUseId?: unknown } | undefined;
      const input = body?.input ?? {};
      if (
        typeof body?.tool !== 'string' ||
        body.tool === '' ||
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input)
      ) {
        return reply.code(400).send(apiError('hook-call-unreadable', 'Вызов хука не читается'));
      }
      return answerHookCall(
        got.task,
        got.binding,
        {
          tool: body.tool,
          input: input as Record<string, unknown>,
          // Не строка или пусто — как будто CLI id не дал: вызов решается, только без id.
          ...(typeof body.toolUseId === 'string' && body.toolUseId !== ''
            ? { toolUseId: body.toolUseId }
            : {}),
        },
        permit,
      );
    },
  );
}
