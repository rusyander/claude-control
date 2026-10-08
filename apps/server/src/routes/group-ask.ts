import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { runAssistant } from '../domains/assistant-runner/assistant-runner.ts';
import type { EntityToggleDeps } from '../domains/entity-toggle.ts';
import { resolveAssistantEndpoint } from '../domains/endpoints/endpoints.ts';
import type { ZodType } from 'zod';
import { badGroupRequest, GroupRequestError, refusalBody } from '../domains/groups/errors.ts';
import { issuesOf } from '../lib/request-body.ts';
import { cheapModelFor, GroupModelError, type GroupAsk } from '../domains/groups/model.ts';
import { codeOf } from '../lib/server-text/server-text.ts';
import { getActiveProvider } from '../providers/registry.ts';

/**
 * Общее для маршрутов групп по областям и «Пути»: зависимости доменов из
 * контекста (собираются на каждом запросе — каталог конфигурации меняется на
 * лету) и служебный вызов модели через общий раннер ассистента.
 */

export function groupDeps(ctx: ServerContext): EntityToggleDeps {
  return { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir };
}

/**
 * Вызов модели активного провайдера. `cheap` — младшая ступень (у Claude —
 * `haiku`); свой эндпоинт панели, если выбран, уважается так же, как у
 * ассистента: данные уходят туда, куда человек их направил.
 */
export function groupAsk(
  ctx: ServerContext,
  /** Переключатель Claude на локальную модель; без него `claude -p` ушёл бы в облако. */
  claudeEnv?: () => Record<string, string>,
): GroupAsk {
  return async (messages, tier) => {
    const provider = getActiveProvider(ctx.store);
    const models = ctx.models.current(provider.modelVendors ?? []).models;
    const model = tier === 'cheap' ? cheapModelFor(provider, models) : undefined;
    const result = await runAssistant(provider, messages, {
      appDataDir: ctx.location.paths.appData,
      models,
      endpoint: resolveAssistantEndpoint(ctx.store, ctx.location.paths.appData),
      ...(model ? { model } : {}),
      ...(claudeEnv ? { claudeEnv } : {}),
    });
    if (!result.ok) throw new GroupModelError(result.reason, result.error);
    return result.reply;
  };
}

/** Тело по схеме; не так — отказ 400 с полем и причиной (`group-request-invalid`). */
export function parseGroupBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = issuesOf(result.error)[0];
  throw badGroupRequest(`${issue?.path ?? ''}: ${issue?.message ?? ''}`);
}

/** Отказ домена → ответ; чужая ошибка уходит дальше (500 с логом). */
export function sendGroupError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof GroupRequestError) {
    return reply.code(error.statusCode).send(refusalBody(error));
  }
  if (error instanceof GroupModelError) {
    return reply.code(502).send({
      error: 'model_failed',
      messageCode: 'group-model-failed',
      params: { reason: error.reason },
    });
  }
  const coded = codeOf(error);
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (coded.messageCode && typeof status === 'number' && status >= 400 && status < 500) {
    return reply
      .code(status)
      .send({ error: (error as { code?: string }).code ?? 'refused', ...coded });
  }
  throw error;
}
