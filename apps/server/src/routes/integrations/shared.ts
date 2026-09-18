import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import type { AtlassianAccess } from '../../domains/integrations/atlassian/client.ts';
import { toAccess } from '../../domains/integrations/atlassian/client.ts';
import { IntegrationError, invalidField } from '../../domains/integrations/errors.ts';
import { readIntegrations, requireConnected } from '../../domains/integrations/store.ts';
import { codeOf } from '../../lib/server-text.ts';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';

/**
 * Общее для всех маршрутов интеграций: доступ к Atlassian, перевод отказов в
 * ответы и разбор полей тела.
 *
 * Тело здесь проверяется РУКАМИ, а не схемой: общий файл схем принадлежит
 * другой зоне ответственности, а ответ «не заполнено поле X» важнее красоты
 * проверки — человек по нему сразу видит, чего не хватило.
 */

export interface IntegrationsDeps {
  ctx: ServerContext;
  /** Адрес самой панели: его получает переходник MCP, и только его. */
  selfBaseUrl: string;
}

export function appDataOf(deps: IntegrationsDeps): string {
  return deps.ctx.location.paths.appData;
}

/** Доступ к Atlassian из настроек и сохранённого токена. */
export function atlassianAccess(deps: IntegrationsDeps): AtlassianAccess {
  const token = requireConnected(deps.ctx.store, appDataOf(deps), 'atlassian', 'Atlassian');
  return toAccess(readIntegrations(deps.ctx.store).atlassian, token);
}

/**
 * Отказ интеграции — это ответ с кодом и человеческой причиной.
 *
 * Код берётся у самой ошибки: клиент отличает «не настроено» (404) от «не
 * отвечает» (502) по коду, а не разбором текста. `detail` отдаётся отдельно —
 * в нём хвост ответа чужой системы, полезный при разборе, но не годящийся в
 * заголовок карточки.
 */
export function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof IntegrationError) {
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, ...codeOf(error), detail: error.detail });
  }
  throw error;
}

/** Асинхронный маршрут: всё наружу асинхронно, поэтому вариант только один. */
export async function guard<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await action();
  } catch (error) {
    return fail(reply, error);
  }
}

/** Обязательная строка тела: пустая — 400 с именем поля. */
export function requireString(
  value: unknown,
  field: string,
  why: string,
  code?: ServerMessageCode,
  params?: ServerMessageParams,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw invalidField(field, why, code, params);
  return text;
}

/** Необязательная строка: пустая превращается в `undefined`. */
export function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

/** Потолок выборки: чужие API отдают сотни, а списку в панели столько не нужно. */
export function limitOf(value: unknown, fallback = 25): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}
