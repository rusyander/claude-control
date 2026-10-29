import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CaptureAnswer, CaptureRequest } from '@agentdeck/contracts/core/records';
import { z } from 'zod';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { tokenEquals } from '../platform/token-file.ts';
import { bearerOf } from './auth.ts';
import { apiError } from './errors.ts';
import type {
  CaptureCheckAsk,
  CaptureResultOwner,
  SessionCaptureDeps,
} from './session-capture.types.ts';

export type {
  CaptureCheckAsk,
  CaptureEntry,
  CaptureResultOwner,
  SessionCaptureDeps,
} from './session-capture.types.ts';

/**
 * Ручка захвата проверок (03 §Process capture, 04:35-43): прокладка (`--require`) и обёртки PATH
 * спрашивают здесь, прежде чем исполнить проверку, и несут сюда итог прогона под арендой.
 *
 * Доступ — двумя ключами: токен сессии ядра (происхождение `session`, задача и шаг — из журнала по
 * токену) или доступ захвата `<дом ядра>/capture-token` (происхождение `pseudo`, задача — по
 * предку-CLI, G5). Тело называет только argv, каталог, окружение (хеш и значения имён прокладки — в
 * памяти ядра для ключа, не в записях) и pid — задачу и шаг тело не
 * называет, поэтому чужой шаг вопросом не достать. Ответ решает единственный вход проверок (G21);
 * его нет — 503, и прокладка прогоняет сама (сомнение → прогон, F25), а итог ложится в очередь.
 */

export const CAPTURE_PATH = '/v1/session/capture';
export const CAPTURE_RESULT_PATH = '/v1/session/capture/result';
/** Итог несёт лог голова+хвост до 2 МБ; экранирование JSON раздувает его — запас вчетверо. */
const RESULT_BODY_LIMIT = 16 * 1024 * 1024;

const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CAPTURE_REQUEST = z
  .object({
    road: z.enum(['node-preload', 'path-wrapper']),
    argv: z.array(z.string()).min(1).max(4096),
    cwd: z.string().min(1),
    envDigest: z.string().regex(SHA),
    env: z
      .record(z.string().min(1).max(256), z.string().max(32_768).nullable())
      .refine((env) => Object.keys(env).length <= 256),
    pid: z.number().int().positive(),
    pidStart: z.number().int().nonnegative(),
    ancestor: z
      .object({ pid: z.number().int().positive(), start: z.number(), image: z.string() })
      .strict()
      .optional(),
  })
  .strict();

export const CAPTURE_RESULT = z
  .object({
    leaseId: z.string().regex(UUID),
    checkRunId: z.string().regex(UUID),
    exit: z.number().int().nullable(),
    signal: z.string().nullable(),
    ms: z.number().nonnegative(),
    log: z.string(),
    // Необязателен: обёртки прежних сборок поле не шлют.
    truncated: z.boolean().optional(),
  })
  .strict();

type Caller =
  { origin: 'session'; taskId: string; sessionId: string; stepId: string } | { origin: 'pseudo' };

/** Кто спрашивает: сессия (по токену и журналу) или держатель доступа захвата; иначе — отказ. */
async function callerOf(
  deps: SessionCaptureDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Caller | undefined> {
  const token = bearerOf(request.headers.authorization);
  if (!token) {
    void reply
      .code(401)
      .send(apiError('capture-token-required', 'Нужен токен сессии или доступ захвата'));
    return undefined;
  }
  const claim = deps.tokens.verify(token);
  if (claim) {
    const opened = await deps.registry.open(claim.taskId);
    if ('refused' in opened) {
      void reply.code(409).send(apiError('task-unavailable', opened.refused));
      return undefined;
    }
    const bound = bindingOf(opened.task, claim.sessionId);
    if ('refused' in bound) {
      void reply.code(403).send(apiError(bound.refused, bound.reason));
      return undefined;
    }
    return {
      origin: 'session',
      taskId: bound.binding.taskId,
      sessionId: bound.binding.sessionId,
      stepId: bound.binding.stepId,
    };
  }
  const capture = deps.captureToken();
  if ('value' in capture && tokenEquals(capture.value, token)) return { origin: 'pseudo' };
  void reply
    .code(401)
    .send(apiError('capture-token-required', 'Нужен токен сессии или доступ захвата'));
  return undefined;
}

/** Итог забора очереди (форма `SpoolOutcome` зоны A; ручка знает только эти поля). */
interface DrainOutcome {
  taken?: string[];
  bad?: { file: string; reason: string }[];
  kept?: { file: string; reason: string }[];
  unread?: string;
}

const ROAD: Record<CaptureRequest['road'], CaptureCheckAsk['road']> = {
  'node-preload': 'capture-preload',
  'path-wrapper': 'capture-wrapper',
};

export function registerSessionCapture(app: FastifyInstance, deps: SessionCaptureDeps): void {
  const note = deps.note ?? (() => undefined);
  let draining: Promise<unknown> | undefined;
  /** Забор очереди — один за раз; сбой забора не мешает ответу (он назван в заметке ядра). */
  const drain = async (): Promise<void> => {
    if (!deps.drainSpool) return;
    draining ??= deps.drainSpool().finally(() => {
      draining = undefined;
    });
    try {
      // Итог забора — в заметку ядра, когда в нём есть что назвать: файлы в `bad/`, оставленные с
      // причиной, нечитаемый каталог (A2-F03: иначе очередь копится молча).
      const outcome = (await draining) as DrainOutcome | undefined;
      const bad = outcome?.bad ?? [];
      const kept = outcome?.kept ?? [];
      if (bad.length > 0 || kept.length > 0 || outcome?.unread) {
        note('capture.spool', {
          taken: outcome?.taken?.length ?? 0,
          bad,
          kept,
          ...(outcome?.unread ? { unread: outcome.unread } : {}),
        });
      }
    } catch (error) {
      note('capture.spool.failed', { reason: (error as Error).message });
    }
  };

  app.post(CAPTURE_PATH, async (request, reply) => {
    const caller = await callerOf(deps, request, reply);
    if (!caller) return reply;
    const parsed = CAPTURE_REQUEST.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(apiError('capture-unreadable', 'Вопрос захвата не читается'));
    }
    const body = parsed.data;
    await drain();
    let ask: CaptureCheckAsk;
    if (caller.origin === 'session') {
      ask = {
        road: ROAD[body.road],
        origin: 'session',
        taskId: caller.taskId,
        sessionId: caller.sessionId,
        stepId: caller.stepId,
        argv: body.argv,
        cwd: body.cwd,
        envDigest: body.envDigest,
        env: body.env,
        caller: { pid: body.pid, pidStart: body.pidStart },
      };
    } else {
      // Задача — по предку-CLI самого процесса, не по полю `ancestor` тела: его пишет звонящий.
      // `pid` и `pidStart` тоже названы звонящим (A2-F06): цепочка строится, только если строка
      // таблицы ОС с этим pid стартовала в названный миг (`callerAncestry`), иначе — вне очереди.
      const pseudo = deps.pseudo
        ? await deps.pseudo.resolve({ pid: body.pid, pidStart: body.pidStart })
        : { outside: 'pseudo-tasks not wired: check runs outside the queue' };
      if ('outside' in pseudo) {
        note('capture.outside', { argv: body.argv, cwd: body.cwd, reason: pseudo.outside });
        const through: CaptureAnswer = { kind: 'pass-through' };
        return { ...through, outside: pseudo.outside };
      }
      ask = {
        road: 'pseudo',
        origin: 'pseudo',
        taskId: pseudo.taskId,
        sessionId: null,
        stepId: null,
        argv: body.argv,
        cwd: body.cwd,
        envDigest: body.envDigest,
        env: body.env,
        caller: { pid: body.pid, pidStart: body.pidStart },
      };
    }
    if (!deps.entry) {
      return reply
        .code(503)
        .send(
          apiError('check-entry-absent', 'Входа проверок в этой сборке нет — прогон без очереди'),
        );
    }
    const answer = await deps.entry.ask(ask);
    if (ask.origin === 'pseudo') {
      deps.pseudo?.note(ask.taskId, {
        event: 'ask',
        argv: ask.argv,
        cwd: ask.cwd,
        answer: answer.kind,
      });
    }
    return answer;
  });

  app.post(CAPTURE_RESULT_PATH, { bodyLimit: RESULT_BODY_LIMIT }, async (request, reply) => {
    const caller = await callerOf(deps, request, reply);
    if (!caller) return reply;
    const parsed = CAPTURE_RESULT.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(apiError('capture-result-unreadable', 'Итог захвата не читается'));
    }
    if (!deps.entry) {
      return reply
        .code(503)
        .send(apiError('check-entry-absent', 'Входа проверок в этой сборке нет'));
    }
    const owner: CaptureResultOwner =
      caller.origin === 'session'
        ? { origin: 'session', taskId: caller.taskId }
        : { origin: 'pseudo', taskId: null };
    const taken = await deps.entry.result(owner, parsed.data);
    if ('refused' in taken) {
      return reply.code(409).send(apiError('capture-result-refused', taken.refused));
    }
    return { taken: true };
  });
}
