import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { createCoreAskPort } from '../domains/core-ask/core-ask.ts';
import type { CoreAskPort } from '../domains/core-ask/core-ask.types.ts';
import { askMasked } from '../domains/core-ask/one-shot.ts';
import type { EntityToggleDeps } from '../domains/entity-toggle.ts';
import type { ZodType } from 'zod';
import { badGroupRequest, GroupRequestError, refusalBody } from '../domains/groups/errors.ts';
import { issuesOf } from '../lib/request-body.ts';
import { cheapModelFor, GroupModelError, type GroupAsk } from '../domains/groups/model.ts';
import { codeOf } from '../lib/server-text/server-text.ts';
import { coreHomeOf } from '../lib/hop-recorder.mjs';
import { getActiveProvider } from '../providers/registry.ts';

/**
 * Общее для маршрутов групп по областям и «Пути»: зависимости доменов из
 * контекста (собираются на каждом запросе — каталог конфигурации меняется на
 * лету) и служебный вызов модели вопросом ядра «ask» (`core-ask/one-shot.ts`).
 */

export function groupDeps(ctx: ServerContext): EntityToggleDeps {
  return { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir };
}

/**
 * Вызов модели активного провайдера вопросом ядра. `cheap` — младшая ступень (у Claude —
 * `haiku`) потолком модели вопроса; профиль «Ассистент панели» и контур судит ядро так же,
 * как у ассистента: данные уходят туда, куда человек их направил.
 */
export function groupAsk(
  ctx: ServerContext,
  port: CoreAskPort = createCoreAskPort(() => coreHomeOf()),
): GroupAsk {
  return async (messages, tier) => {
    const provider = getActiveProvider(ctx.store);
    const models = ctx.models.current(provider.modelVendors ?? []).models;
    const model = tier === 'cheap' ? cheapModelFor(provider, models) : undefined;
    const result = await askMasked(port, ctx.store, ctx.location.paths.appData, {
      title: 'groups',
      messages,
      ...(model ? { model } : {}),
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
